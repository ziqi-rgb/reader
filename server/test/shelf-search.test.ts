import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/index.ts';
import { ShelfService } from '../src/services/shelf.ts';

/**
 * 搜索框里的字符就是书名里的字符。
 *
 * `%` 和 `_` 是 LIKE 的通配符，不转义时搜「100%」会把整排书架都列出来；`:` 之类在
 * LIKE 里本来就是字面量，所以这一条同时钉住「冒号书名搜得到」。
 */
test('shelf search treats wildcard characters and punctuation as literal text', () => {
  const db = new Db(':memory:'), shelf = new ShelfService(db);
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0)");
    const titles: Record<string, string> = { pct: '100% 纯爱', underscore: 'A_B 手记', colon: 'Re:从零开始', plain: '普通小说' };
    Object.entries(titles).forEach(([id, title], index) => {
      db.run("INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at) VALUES(?,?,'epub',?,'作者',1,?)", id, 'h-' + id, title, index + 1);
      db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)', 'f-' + id, id, id + '.epub');
      db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', 'u', id, index);
    });
    db.run("UPDATE books SET tags='[\"a_b\"]' WHERE id='underscore'");

    const search = (query: string) => shelf.list('u', { search: query, pageSize: 50 }).items.map(book => book.id);
    assert.deepEqual(search('100%'), ['pct']);
    assert.deepEqual(search('%'), ['pct']);
    assert.deepEqual(search('A_B'), ['underscore']);
    assert.deepEqual(search('_'), ['underscore']);
    assert.deepEqual(search('Re:从零开始'), ['colon']);
    assert.deepEqual(search('从零'), ['colon']);
    assert.deepEqual(shelf.list('u', { tag: 'a_b', pageSize: 50 }).items.map(book => book.id), ['underscore']);
  } finally { db.close(); }
});
