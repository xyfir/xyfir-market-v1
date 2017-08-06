const messages = require('constants/messages');
const config = require('constants/config');
const moment = require('moment');
const mysql = require('lib/mysql');
const snoo = require('snoowrap');

const r = new snoo(config.snoowrap);

/**
 * Updates the daily thread and removes expired sales threads.
 */
module.exports = async function() {

  const db = new mysql;

  try {
    // Get ids of all threads that are over a week old
    await db.getConnection();
    let rows = await db.query(
      'SELECT id FROM sales_threads WHERE created < ?',
      [moment().subtract(1, 'week').utc().unix()]
    );

    if (rows.length) {
      // Delete threads from database
      await db.query(
        'DELETE FROM sales_threads WHERE id IN (?)',
        [rows.map(r => r.id)]
      );

      for (let row of rows) {
        const thread = await r.getSubmission(row.id);

        // Remove (not delete) thread from subreddit
        await thread.remove();

        // Notify creator that their thread has expired and that they can repost
        await thread.reply(messages.SALES_THREAD_EXPIRED(thread.id));
      }
    }

    // Grab full data for all remaining threads in database
    rows = await db.query(
      'SELECT id, data, promoted FROM sales_threads WHERE approved = 1'
    );
    db.release();

    if (!rows.length) return;

    rows = rows.map(row => {
      const { title, category } = JSON.parse(row.data);
      row.data = { title, category };
      return row;
    });
  
    // Categorize threads
    let categories = {};

    rows.forEach(row => {
      if (!categories[row.data.category])
        categories[row.data.category] = [];

      categories[row.data.category].push(row);
    });

    rows = null;

    const text = Object
      .keys(categories)
      .sort(() => Math.round(Math.random()) ? 1 : -1)
      .map(category =>
        `- **${category}**\n` +
        categories[category]
          // Promoted threads go to top
          // Both promoted and normal are randomly sorted (but separate)
          .sort((a, b) => {
            if (!a.promoted && b.promoted)
              return 1;
            else if (a.promoted && !b.promoted)
              return -1;
            else
              return Math.round(Math.random()) ? 1 : -1;
          })
          // Convert to string for post
          .map(thread =>
            `  - ${thread.promoted ? '⭐ ' : ''}` +
            `[${thread.data.title}](/r/xyMarket/comments/${thread.id})`
          )
          .join('\n')
      )
      .join('\n');
    
    categories = null;
    
    // Get age of daily thread
    let daily = await r
      .getSubreddit('xyMarket')
      .getSticky({ num: 1 })
      .fetch(),
    expires = moment
      .unix(daily.created_utc)
      .utc()
      .add(1, 'day')
      .unix();

    // Remove current daily thread and create a new one
    if (expires < moment.utc().unix()) {
      await daily.remove();

      daily = await r
        .getSubreddit('xyMarket')
        .submitSelfpost({
          text,
          title: 'Daily Thread',
          sendReplies: false
        })
        .approve()
        .sticky({ num: 1 });
    }
    // Edit current daily thread
    else {
      await daily.edit(text);
    }
  }
  catch (err) {
    db.release();
    console.error('main/updateThreads', err);
  }
  
}