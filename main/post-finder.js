const createUser = require('lib/users/create');
const templates = require('constants/templates');
const config = require('constants/config');
const moment = require('moment');
const MySQL = require('lib/mysql');
const snoo = require('snoowrap');

const r = new snoo(config.snoowrap);

/**
 * Finds posts in similar subreddits, contacts the posters, and optionally 
 * reposts to xyMarket as unstructured.
 */
module.exports = async function() {

  console.log('main/post-finder: start');

  const db = new MySQL;

  try {
    const subreddits = [
      'BitMarket', 'redditbay', 'barter', 'forsale', 'Sell', 'marketplace',
      'REDDITEXCHANGE', 'giftcardexchange', 'appleswap', 'GameSale',
      'SteamGameSwap'
    ],
    subredditCategory = {
      giftcardexchange: 'Vouchers & Gift Cards',
      SteamGameSwap: 'Games & Virtual Items',
      appleswap: 'Electronics',
      GameSale: 'Games & Virtual Items'
    };

    let posts = [], mods = [];

    for (let sub of subreddits) {
      // Load new posts
      let _posts = await r.getSubreddit(sub).getNew();

      _posts = _posts
        // Filter out posts over 2 hours old (should already have been seen)
        .filter(post =>
          moment.utc().subtract(2, 'hours').unix() < post.created_utc
        )
        // Ignore link and empty selftext posts
        .filter(post => !!post.selftext)
        // Ignore posts marked as completed or closed
        .filter(post =>
          !post.link_flair_text || !/complete|close/i.test(post.link_flair_text)
        )
        // BitMarket threads must start with [WTS]
        .filter(post => !(sub == 'BitMarket' && !/\[WTS\]/.test(post.title)))
        // Make sure posts in trade subreddits with strict title formats are
        // looking to receive some known currency
        .filter(post => {
          if (subreddits.indexOf(sub) < 6) return true;

          // Title must be [H] <something> [W] <something>
          if (!/\[H\].+\[W\]/.test(post.title)) return false;

          const want = post.title.split('[W]')[1];

          if (/\bPayPal|BTC|Bitcoin|ETH|Ethereum|LTC|Litecoin\b/i.test(want))
            return true;
        });
      posts = posts.concat(_posts);

      // Load moderators
      let _mods = await r.getSubreddit(sub).getModerators();

      _mods = _mods
        // Just get their username
        .map(mod => mod.name)
        // Filter out moderators already in array
        .filter(mod => mods.indexOf(mod) == -1);
      mods = mods.concat(_mods);
    }

    // Ignore posts made by users in mods[]
    posts = posts.filter(post =>
      mods.findIndex(mod => post.author.name == mod) == -1
    );

    if (!posts.length) return console.log('main/post-finder: end1');

    await db.getConnection();

    for (let post of posts) {
      const author = await post.author.fetch();

      // Author must have positive comment and link karma
      if (author.comment_karma < 0 || author.link_karma < 0) continue;

      // Thread must not already exist in database
      const rows = await db.query(`
        SELECT id FROM sales_threads
        WHERE author = ? AND unstructured = ? AND created > ?
      `, [
        author.name, 1, moment.utc().subtract(2, 'hours').unix()
      ]);

      if (rows.length) continue;

      let text = '';

      // Post to r/xyMarket as unstructured
      const repost = await r
        .getSubreddit(config.ids.reddit.sub)
        .submitSelfpost({
          title: post.title,
          text: templates.POST_FINDER_REPOST(post.permalink, post.selftext)
        })
        .disableInboxReplies()
        .approve()
        .assignFlair({
          text: 'Unstructured', cssClass: 'unstructured'
        })
        .fetch();

      text = templates.POST_FINDER_REPOSTED(
        post.permalink, repost.permalink
      );

      await createUser(author.name, db);

      await db.query(`
        INSERT INTO sales_threads SET ?
      `, {
        id: repost.id, author: post.author.name, created: repost.created_utc,
        unstructured: true, approved: true,
        data: JSON.stringify({
          category: subredditCategory[post.subreddit.display_name],
          title: repost.title
        })
      });

      // Notify author
      await r.composeMessage({
        to: author.name,
        text,
        subject: 'r/xyMarket'
      });
    }

    db.release();
    console.log('main/post-finder: end2');
  }
  catch (err) {
    db.release();
    console.error('main/post-finder', err);
  }
  
}