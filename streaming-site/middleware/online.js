// In-memory online user tracker
// Maps token hash -> last heartbeat timestamp
const sessions = new Map();
const TTL = 65000; // 65 seconds — expire if no heartbeat within this window

function heartbeat(tokenHash) {
  sessions.set(tokenHash, Date.now());
}

function cleanup() {
  const now = Date.now();
  for (const [key, ts] of sessions) {
    if (now - ts > TTL) sessions.delete(key);
  }
}

// Cleanup stale sessions every 30 seconds
setInterval(cleanup, 30000);

function getOnlineCount() {
  cleanup();
  return sessions.size;
}

module.exports = { heartbeat, getOnlineCount };
