// 存储层：只负责 db.json 的读写与并发串行化，不含任何业务规则。
const fs = require('fs/promises');
const path = require('path');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

let queue = Promise.resolve();

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

// 所有写操作串行执行，避免「读-改-写」之间互相覆盖（并发登记同一瓶号等场景）。
function withLock(task) {
  const run = queue.then(() => task());
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

module.exports = { readDb, writeDb, withLock, DB_FILE };
