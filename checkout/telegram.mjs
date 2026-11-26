export function installTelegramOutbox(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS telegram_recipients (
      bot_id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS telegram_outbox (
      request_id TEXT PRIMARY KEY REFERENCES rentals(request_id),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      lease_until INTEGER NOT NULL DEFAULT 0,
      delivered_at INTEGER
    ) STRICT;

    CREATE INDEX IF NOT EXISTS telegram_outbox_pending ON telegram_outbox (next_attempt_at)
      WHERE delivered_at IS NULL;

    CREATE TRIGGER IF NOT EXISTS telegram_alert_after_payment
    AFTER UPDATE OF status ON rentals
    WHEN OLD.status <> 'paid' AND NEW.status = 'paid'
    BEGIN
      INSERT OR IGNORE INTO telegram_outbox (request_id) VALUES (NEW.request_id);
    END;
  `);
}

export function createTelegramAlerts({ database, token, pairingCode, completeRental, request = fetch, log = console }) {
  const botId = token.split(':', 1)[0];
  const getRecipient = database.prepare('SELECT chat_id FROM telegram_recipients WHERE bot_id = ?');
  const saveRecipient = database.prepare('INSERT OR IGNORE INTO telegram_recipients (bot_id, chat_id) VALUES (?, ?)');
  const claim = database.prepare(`
    UPDATE telegram_outbox SET lease_until = ?, attempts = attempts + 1
    WHERE request_id = (
      SELECT request_id FROM telegram_outbox
      WHERE delivered_at IS NULL AND next_attempt_at <= ? AND lease_until <= ?
      ORDER BY next_attempt_at, rowid LIMIT 1
    )
    RETURNING request_id, attempts
  `);
  const getRental = database.prepare('SELECT tracking_id, session_id FROM rentals WHERE request_id = ?');
  const delivered = database.prepare('UPDATE telegram_outbox SET delivered_at = ?, lease_until = 0 WHERE request_id = ?');
  const retry = database.prepare('UPDATE telegram_outbox SET next_attempt_at = ?, lease_until = 0 WHERE request_id = ?');
  let updateOffset = 0;
  let nextUpdatePollAt = 0;
  let active = false;

  async function telegram(method, body) {
    const response = await request(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000)
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) {
      const error = new Error('Telegram API request failed.');
      error.retryAfter = data.parameters?.retry_after;
      error.status = response.status;
      throw error;
    }
    return data.result;
  }

  async function getUpdates(now) {
    if (now < nextUpdatePollAt) return [];
    try {
      return await telegram('getUpdates', { offset: updateOffset, timeout: 0, limit: 20, allowed_updates: ['message'] });
    } catch (error) {
      nextUpdatePollAt = now + Math.max(Number(error.retryAfter) || 0, 60);
      log.warn('Telegram updates are temporarily unavailable.', error.status ?? 'network');
      return [];
    }
  }

  async function pairChat(now) {
    if (!pairingCode) return;
    const updates = await getUpdates(now);
    for (const update of updates) {
      updateOffset = update.update_id + 1;
      const message = update.message;
      if (message?.chat?.type !== 'private' ||
          !Number.isSafeInteger(message.chat.id) ||
          message.text?.trim() !== `/start ${pairingCode}`) {
        continue;
      }
      if (saveRecipient.run(botId, String(message.chat.id)).changes !== 1) return;

      log.info('Telegram rental alerts paired.');
      try {
        await telegram('sendMessage', {
          chat_id: message.chat.id,
          text: 'UnemployedKittens is connected. Verified Rent a Kitten payments will send a notification here.'
        });
        log.info('Telegram pairing confirmation delivered.');
      } catch (error) {
        log.warn('Telegram pairing confirmation could not be delivered.', error.status ?? 'network');
      }
      return;
    }
  }

  async function readCommands(now, chatId) {
    const updates = await getUpdates(now);
    for (const update of updates) {
      const message = update.message;
      if (message?.chat?.type === 'private' && String(message.chat.id) === chatId) {
        const command = message.text?.trim().match(/^\/complete(?:@\w+)?(?:\s+(\S+))?$/i);
        if (command) {
          const trackingId = command[1]?.toUpperCase() ?? '';
          const text = /^UK-[A-F0-9-]{36}$/.test(trackingId)
            ? completeRental(trackingId) : 'Send /complete followed by the rental tracking ID.';
          try {
            await telegram('sendMessage', { chat_id: Number(chatId), text });
          } catch (error) {
            log.warn('Telegram could not acknowledge the completion command.', error.status ?? 'network');
          }
        }
      }
      updateOffset = update.update_id + 1;
    }
  }

  async function tick() {
    if (active) return;
    active = true;
    try {
      const now = Math.floor(Date.now() / 1000);
      const recipient = getRecipient.get(botId);
      if (!recipient) {
        await pairChat(now);
        return;
      }

      if (completeRental) await readCommands(now, recipient.chat_id);

      const queued = claim.get(now + 60, now, now);
      if (!queued) return;
      const rental = getRental.get(queued.request_id);
      try {
        await telegram('sendMessage', {
          chat_id: Number(recipient.chat_id),
          text: [
            'A kitten was rented!',
            `Tracking ID: ${rental.tracking_id}`,
            `Verified payment: ${rental.session_id ? 'Stripe' : 'USDC on Solana'}`
          ].join('\n')
        });
        delivered.run(Math.floor(Date.now() / 1000), queued.request_id);
        log.info('Telegram rental alert delivered.');
      } catch (error) {
        const delay = Math.max(Number(error.retryAfter) || 0, Math.min(3600, 10 * 2 ** Math.min(queued.attempts, 10)));
        retry.run(Math.floor(Date.now() / 1000) + delay, queued.request_id);
        log.warn('Telegram rental alert will retry.', error.status ?? 'network');
      }
    } catch {
      log.error('Telegram alert worker could not read or update its queue.');
    } finally {
      active = false;
    }
  }

  return {
    tick,
    start() {
      const interval = setInterval(tick, 10_000);
      interval.unref();
      void tick();
    }
  };
}
