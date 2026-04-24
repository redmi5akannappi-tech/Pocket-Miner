const crypto = require('crypto');

/**
 * Telegram Web App auth middleware
 *
 * In production: validates HMAC-SHA256 of initData from Telegram.
 * In development (DEV_BYPASS=true): accepts a mock user for testing.
 */
function validateTelegramAuth(req, res, next) {
  // Dev bypass for easy local testing
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_BYPASS === 'true') {
    req.telegramUser = {
      telegramId: req.headers['x-telegram-id'] || 'dev_user_12345',
      username: req.headers['x-username'] || 'dev_miner',
      firstName: 'Dev',
      lastName: 'Miner',
    };
    return next();
  }

  const initData = req.headers['x-telegram-init-data'];
  if (!initData) {
    return res.status(401).json({ error: 'Missing Telegram init data' });
  }

  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not set');

    const parsed = new URLSearchParams(initData);
    const hash = parsed.get('hash');
    parsed.delete('hash');

    // Sort keys and build data-check-string
    const dataCheckString = Array.from(parsed.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    // HMAC-SHA256
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (expectedHash !== hash) {
      return res.status(401).json({ error: 'Invalid Telegram signature' });
    }

    // Check auth_date freshness (24 hours)
    const authDate = parseInt(parsed.get('auth_date'));
    if (Date.now() / 1000 - authDate > 86400) {
      return res.status(401).json({ error: 'Init data expired' });
    }

    // Parse user
    const userJson = parsed.get('user');
    const tgUser = userJson ? JSON.parse(userJson) : null;

    if (!tgUser?.id) {
      return res.status(401).json({ error: 'User data missing' });
    }

    req.telegramUser = {
      telegramId: String(tgUser.id),
      username: tgUser.username || '',
      firstName: tgUser.first_name || '',
      lastName: tgUser.last_name || '',
      avatarUrl: tgUser.photo_url || '',
    };

    next();
  } catch (err) {
    console.error('[AUTH]', err.message);
    res.status(401).json({ error: 'Authentication failed' });
  }
}

module.exports = { validateTelegramAuth };
