import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { Db, openDatabase } from '../src/db/index.ts';
import { ShelfService } from '../src/services/shelf.ts';
import { GroupService } from '../src/services/groups.ts';
import { UserService } from '../src/services/users.ts';
import { Scanner } from '../src/indexer/scanner.ts';
import { buildApp } from '../src/http/app.ts';
import type { AppContext } from '../src/http/context.ts';
import type { AppConfig } from '../src/config/index.ts';

/**
 * Groups are the reader's own structure: per account, many-to-many, and the only
 * dimension the shelf filters on (series and tags come from the file).
 */
test('groups are per-account, many-to-many, and drive the shelf filter', () => {
  const db = new Db(':memory:'), shelf = new ShelfService(db), groups = new GroupService(db);
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0),('v','other','x','member',0,0)");
    for (const [index, id] of ['scifi-1', 'scifi-2', 'plain'].entries()) {
      db.run(
        `INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
         VALUES(?,?,'epub',?,'作者',1,?)`, id, 'h-' + id, id, index + 1,
      );
      db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)', 'f-' + id, id, id + '.epub');
      db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', 'u', id, index);
    }

    // --- create / list / rename ---
    const scifi = groups.create('u', ' 科幻 ');
    const later = groups.create('u', '待读');
    assert.deepEqual(groups.list('u').map(group => group.name), ['待读', '科幻'], 'trimmed, sorted by name');
    assert.equal(scifi.name, '科幻', 'whitespace is compressed away');
    assert.equal(scifi.bookCount, 0);
    // NOCASE uniqueness inside one account, and accounts do not collide with each other.
    assert.throws(() => groups.create('u', '科幻'), { statusCode: 400 });
    assert.throws(() => groups.create('u', '  科幻  '), { statusCode: 400 });
    assert.doesNotThrow(() => groups.create('v', '科幻'));
    assert.throws(() => groups.create('u', '   '), { statusCode: 400 });
    assert.throws(() => groups.create('u', 'x'.repeat(61)), { statusCode: 400 });
    assert.equal(groups.rename('u', later.id, '稍后读').name, '稍后读');

    // --- memberships: one book in several groups ---
    groups.setForBook('u', 'scifi-1', [scifi.id, later.id]);
    groups.setForBook('u', 'scifi-2', [scifi.id]);
    assert.deepEqual(shelf.get('u', 'scifi-1').groups?.map(group => group.name), ['科幻', '稍后读']);
    assert.equal(groups.list('u').find(group => group.id === scifi.id)?.bookCount, 2);

    // Replacing the set removes what is no longer listed.
    groups.setForBook('u', 'scifi-1', [later.id]);
    assert.deepEqual(groups.idsOf('u', 'scifi-1'), [later.id]);
    groups.setForBook('u', 'scifi-1', [scifi.id, later.id]);

    // --- the shelf filter: 或 / 与 / 非 ---
    const ids = (options: Parameters<ShelfService['list']>[1]) =>
      shelf.list('u', { ...options, pageSize: 50, sort: 'title', order: 'asc' }).items.map(book => book.id);
    assert.deepEqual(ids({ groups: [scifi.id] }), ['scifi-1', 'scifi-2']);
    assert.deepEqual(ids({ groups: [scifi.id], groupMode: 'or' }), ['scifi-1', 'scifi-2']);
    assert.deepEqual(ids({ groups: [scifi.id, later.id], groupMode: 'and' }), ['scifi-1']);
    // 一级组 has no mode of its own — it is always a plain condition — so 「非」 on a
    // top-level group means nothing; the mode only reaches 二 / 三 / 四级.
    assert.deepEqual(ids({ groups: [scifi.id], groupMode: 'not' }), ['scifi-1', 'scifi-2']);
    assert.deepEqual(ids({ groups: [scifi.id, later.id], groupMode: 'not' }), ['scifi-1']);
    assert.throws(() => shelf.list('u', { groups: [scifi.id], groupMode: 'xor' as never }), { statusCode: 400 });
    // Everything is listed when no group is selected.
    assert.equal(ids({}).length, 3);

    // --- isolation between accounts ---
    assert.throws(() => groups.require('v', scifi.id), { statusCode: 404 }, 'another account cannot see it');
    assert.throws(() => groups.rename('v', scifi.id, '偷改'), { statusCode: 404 });
    assert.throws(() => groups.remove('v', scifi.id), { statusCode: 404 });
    assert.throws(() => groups.setForBook('v', 'scifi-1', [scifi.id]), { statusCode: 400 }, 'cannot file into a foreign group');
    assert.deepEqual(groups.idsOf('v', 'scifi-1'), []);
    assert.equal(groups.list('v').length, 1, 'v only has its own copy');

    // --- deleting a group unfiles books but keeps them on the shelf ---
    groups.remove('u', later.id);
    assert.deepEqual(groups.idsOf('u', 'scifi-1'), [scifi.id]);
    assert.equal(shelf.list('u', { pageSize: 50 }).total, 3);
  } finally { db.close(); }
});

/**
 * 分组 is a tree written as a path: 「小说.奇幻.剑与魔法」.
 *
 * A child needs its parent to exist, choosing a group includes everything below
 * it (that is what makes a top-level chip a shelf section), and renaming or
 * deleting a group carries its descendants — their names are built on its own.
 */
test('nested groups: paths, subtree filters, cascades and the default group', () => {
  const db = new Db(':memory:'), shelf = new ShelfService(db), groups = new GroupService(db);
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0)");
    const bookIds = ['novel', 'fantasy', 'sword', 'horror', 'scifi'];
    for (const [index, id] of bookIds.entries()) {
      db.run(
        `INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
         VALUES(?,?,'epub',?,'作者',1,?)`, id, 'h-' + id, id, index + 1,
      );
      db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)', 'f-' + id, id, id + '.epub');
      db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', 'u', id, index);
    }

    // --- a child needs its parent; at most three levels; a path needs names ---
    assert.throws(() => groups.create('u', '小说.奇幻'), { statusCode: 400, code: 'GROUP_PARENT_MISSING' });
    const novel = groups.create('u', '小说');
    assert.equal(novel.level, 1);
    assert.equal(novel.parentId, null);
    const fantasy = groups.create('u', '小说.奇幻');
    assert.equal(fantasy.level, 2);
    assert.equal(fantasy.parentId, novel.id);
    const sword = groups.create('u', '小说.奇幻.剑与魔法');
    assert.equal(sword.level, 3);
    assert.equal(sword.parentId, fantasy.id);
    const horror = groups.create('u', '小说.恐怖');
    const scifi = groups.create('u', '科幻');
    // Four levels now: 大类 → 篇幅 → tag → tag 细分.
    const deeper = groups.create('u', '小说.奇幻.剑与魔法.续');
    assert.equal(deeper.level, 4);
    assert.equal(deeper.parentId, sword.id);
    assert.throws(() => groups.create('u', '小说.奇幻.剑与魔法.续.再'), { statusCode: 400, code: 'GROUP_LEVEL_LIMIT' });
    assert.throws(() => groups.create('u', '小说..恐怖'), { statusCode: 400, code: 'GROUP_NAME_INVALID' });
    assert.throws(() => groups.create('u', '小说.'), { statusCode: 400, code: 'GROUP_NAME_INVALID' });
    assert.throws(() => groups.create('u', '.小说'), { statusCode: 400, code: 'GROUP_NAME_INVALID' });

    // A tag may hang straight off a 大类: the skipped level becomes 「-」 in the
    // name, so the level stays readable and the tree stays whole.
    const tag = groups.create('u', '异世界', { parentId: novel.id, level: 3 });
    assert.equal(tag.name, '小说.-.异世界');
    assert.equal(tag.level, 3);
    assert.equal(tag.parentId, novel.id);
    const subTag = groups.create('u', '转生', { parentId: tag.id, level: 4 });
    assert.equal(subTag.name, '小说.-.异世界.转生');
    assert.equal(subTag.level, 4);
    assert.equal(subTag.parentId, tag.id);
    // Which level may sit under which: 二级 under 一级, 三级 under 一/二级, 四级 under 三级.
    assert.throws(() => groups.create('u', '不行', { parentId: novel.id, level: 4 }), { statusCode: 400, code: 'GROUP_LEVEL_INVALID' });
    assert.throws(() => groups.create('u', '不行', { parentId: fantasy.id, level: 4 }), { statusCode: 400, code: 'GROUP_LEVEL_INVALID' });
    assert.throws(() => groups.create('u', '不行', { parentId: sword.id, level: 2 }), { statusCode: 400, code: 'GROUP_LEVEL_INVALID' });
    // 「-」 is the placeholder, never a name of its own.
    assert.throws(() => groups.create('u', '-'), { statusCode: 400, code: 'GROUP_NAME_INVALID' });

    // The stored path borrows the parent's spelling, so descendants always share
    // one prefix (the uniqueness index is NOCASE, prefix matching is not).
    const upper = groups.create('u', 'SciFi');
    const lower = groups.create('u', 'scifi.太空');
    assert.equal(lower.name, 'SciFi.太空');
    assert.equal(lower.parentId, upper.id);

    // --- memberships and subtree counts ---
    groups.setForBook('u', 'novel', [novel.id]);
    groups.setForBook('u', 'fantasy', [fantasy.id]);
    groups.setForBook('u', 'sword', [sword.id]);
    groups.setForBook('u', 'horror', [horror.id]);
    groups.setForBook('u', 'scifi', [scifi.id]);
    const listed = new Map(groups.list('u').map(group => [group.name, group]));
    assert.equal(listed.get('小说')?.bookCount, 1, 'direct members only');
    assert.equal(listed.get('小说')?.subtreeCount, 4, 'a parent counts everything below it');
    assert.equal(listed.get('小说.奇幻')?.bookCount, 1);
    assert.equal(listed.get('小说.奇幻')?.subtreeCount, 2);
    assert.equal(listed.get('小说.奇幻.剑与魔法')?.subtreeCount, 1);
    assert.equal(listed.get('科幻')?.subtreeCount, 1);

    // --- the shelf filter: a selected group includes its descendants ---
    const ids = (options: Parameters<ShelfService['list']>[1]) =>
      shelf.list('u', { ...options, pageSize: 50, sort: 'title', order: 'asc' }).items.map(book => book.id).sort();
    assert.deepEqual(ids({ groups: [novel.id] }), ['fantasy', 'horror', 'novel', 'sword']);
    assert.deepEqual(ids({ groups: [fantasy.id] }), ['fantasy', 'sword']);
    assert.deepEqual(ids({ groups: [sword.id] }), ['sword']);
    assert.deepEqual(ids({ groups: [novel.id], groupMode: 'not' }), ['fantasy', 'horror', 'novel', 'sword'], '一级组 has no mode');
    assert.deepEqual(ids({ groups: [fantasy.id, horror.id], groupMode: 'or' }), ['fantasy', 'horror', 'sword']);
    // A group that does not exist matches nothing instead of widening the filter.
    assert.deepEqual(ids({ groups: ['gone'] }), []);

    // --- renaming a parent renames its descendants ---
    groups.rename('u', novel.id, '文学');
    const names = groups.list('u').map(group => group.name);
    for (const name of ['文学', '文学.奇幻', '文学.奇幻.剑与魔法', '文学.恐怖']) assert.ok(names.includes(name), name);
    assert.ok(!names.includes('小说.奇幻'));
    assert.deepEqual(ids({ groups: [sword.id] }), ['sword'], 'memberships follow the id, not the name');
    assert.equal(groups.list('u').find(group => group.id === fantasy.id)?.parentId, novel.id);

    // A rename cannot collide with a sibling, leave the tree, or pass three levels.
    assert.throws(() => groups.rename('u', horror.id, '文学.奇幻'), { statusCode: 400, code: 'GROUP_NAME_TAKEN' });
    assert.throws(() => groups.rename('u', novel.id, '文学.奇幻.深处'), { statusCode: 400, code: 'GROUP_PARENT_CYCLE' });
    groups.create('u', '创作');
    groups.create('u', '创作.小说');
    assert.throws(() => groups.rename('u', novel.id, '创作.小说.历史'), { statusCode: 400, code: 'GROUP_LEVEL_LIMIT' });

    // --- deleting a parent takes its descendants, and only unfiles books ---
    // Six: two 二级, a 三级 + its 四级, and the tag created straight under it with
    // its own 四级 (the placeholder does not break the prefix).
    assert.equal(groups.descendantCount('u', novel.id), 6);
    groups.remove('u', novel.id);
    assert.deepEqual(groups.list('u').map(group => group.name).filter(name => name.startsWith('文学')), []);
    assert.equal(shelf.list('u', { pageSize: 50 }).total, 5, 'the books stay on the shelf');
    assert.deepEqual(groups.idsOf('u', 'sword'), []);

    // --- the shelf's default group: at most one, stored with the group ---
    assert.equal(groups.setDefault('u', scifi.id), scifi.id);
    assert.deepEqual(groups.list('u').filter(group => group.isDefault).map(group => group.id), [scifi.id]);
    const popular = groups.create('u', '科普');
    groups.setDefault('u', popular.id);
    assert.deepEqual(groups.list('u').filter(group => group.isDefault).map(group => group.id), [popular.id]);
    assert.equal(groups.setDefault('u', null), null);
    assert.equal(groups.list('u').filter(group => group.isDefault).length, 0);
    groups.setDefault('u', popular.id);
    groups.remove('u', popular.id);
    assert.equal(groups.list('u').filter(group => group.isDefault).length, 0, 'deleting the default clears it');
    assert.throws(() => groups.setDefault('u', 'missing'), { statusCode: 404 });
  } finally { db.close(); }
});

/**
 * Names were just names before dots meant levels. An older group called
 * 「web.安全」 must stay reachable: the service creates the missing 「web」 parent
 * rather than renaming the reader's group, and does it only once.
 */
test('a dotted name from an older build gets its missing parents', () => {
  const db = new Db(':memory:');
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0)");
    db.run("INSERT INTO book_groups(id,user_id,name,created_at,updated_at) VALUES('legacy','u','web.安全',1,1)");
    const groups = new GroupService(db);
    const listed = groups.list('u');
    assert.deepEqual(listed.map(group => group.name), ['web', 'web.安全']);
    const parent = listed.find(group => group.name === 'web');
    const child = listed.find(group => group.name === 'web.安全');
    assert.equal(parent?.level, 1);
    assert.equal(child?.level, 2);
    assert.equal(child?.parentId, parent?.id);
    // Idempotent: the next service does not add another 「web」.
    assert.equal(new GroupService(db).list('u').length, 2);
  } finally { db.close(); }
});

/**
 * A manual group and the folder group of the same name are one section.
 *
 * The reader who files 「R18」 by hand and keeps those books in a 「R18」 folder
 * means the same thing twice; two chips made the filter look broken, and picking
 * either one hid the other half of the section.
 */
test('a manual group and the folder group of the same name become one chip', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();
  const books = [
    { id: 'filed', relPath: 'R18/filed.epub' },
    { id: 'both', relPath: 'R18/both.epub' },
    { id: 'folder-only', relPath: 'R18/folder-only.epub' },
    { id: 'other', relPath: 'other/other.epub' },
  ];
  for (const [index, book] of books.entries()) {
    h.db.run(`INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
              VALUES(?,?,'epub',?,'作者',1,1)`, book.id, 'h-' + book.id, book.id);
    h.db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
      'f-' + book.id, book.id, book.relPath);
    h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', owner.id, book.id, index);
  }
  const created = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: 'R18' } });
  const groupId = created.json().group.id as string;
  for (const bookId of ['filed', 'both']) {
    const filed = await h.app.inject({ method: 'PUT', url: `/api/v1/books/${bookId}/groups`, headers: auth(owner), payload: { groupIds: [groupId] } });
    assert.equal(filed.statusCode, 200, filed.body);
  }

  const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json().groups as Array<{ name: string; kind: string; folderIds?: string[]; subtreeCount: number }>;
  const merged = listed.find(group => group.name === 'R18');
  assert.ok(merged, 'the merged chip exists');
  assert.equal(merged.kind, 'manual', 'the stored row is what rename and delete address');
  assert.deepEqual(merged.folderIds, ['folder:R18'], 'the folder of the same name is folded in');
  assert.equal(merged.subtreeCount, 3, 'a book in both counts once');
  assert.equal(listed.filter(group => group.name === 'R18').length, 1, 'one chip, not two');

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map(book => book.id).sort();
  // The merged chip filters both sources at once — that is the point of merging.
  const both = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${encodeURIComponent(`${groupId}+folder:R18`)}`, headers: auth(owner) });
  assert.deepEqual(ids(both.json()), ['both', 'filed', 'folder-only']);
  // The hand-filed group alone is only half of that section.
  const manualOnly = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${groupId}`, headers: auth(owner) });
  assert.deepEqual(ids(manualOnly.json()), ['both', 'filed']);
});

/**
 * 未分组 is "not filed anywhere" — a folder group is filing too.
 *
 * A book under 「故事/长篇」 used to appear in 未分组 as well as under its folder: the
 * chip counted a book its own grid then refused to show, and one book sat in two
 * sections at once. The count and the filter are asserted together because they
 * are two halves of one answer (`GroupService.unfiled` and `groupCondition`).
 */
test('a book filed by its folder is not 未分组', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();
  const books = [
    { id: 'in-folder', relPath: '故事/长篇/in-folder.epub' },
    { id: 'at-root', relPath: 'at-root.epub' },
  ];
  for (const [index, book] of books.entries()) {
    h.db.run(`INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
              VALUES(?,?,'epub',?,'作者',1,1)`, book.id, 'h-' + book.id, book.id);
    h.db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
      'f-' + book.id, book.id, book.relPath);
    h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', owner.id, book.id, index);
  }

  const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json()
    .groups as Array<{ id: string; subtreeCount: number }>;
  assert.equal(listed.find(group => group.id === 'unfiled')?.subtreeCount, 1,
    'only the book sitting at the library root is 未分组');

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map(book => book.id).sort();
  const unfiled = await h.app.inject({ method: 'GET', url: '/api/v1/books?groups=unfiled', headers: auth(owner) });
  assert.deepEqual(ids(unfiled.json()), ['at-root'], 'the chip opens exactly what it counted');

  const folder = await h.app.inject({
    method: 'GET', url: `/api/v1/books?groups=${encodeURIComponent('folder:故事/长篇')}`, headers: auth(owner),
  });
  assert.deepEqual(ids(folder.json()), ['in-folder'], 'and the folder section still holds its book');

  // Filing it by hand moves it between the two answers, never into both.
  const created = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: '读过' } });
  const groupId = created.json().group.id as string;
  await h.app.inject({ method: 'PUT', url: '/api/v1/books/at-root/groups', headers: auth(owner), payload: { groupIds: [groupId] } });
  const after = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json()
    .groups as Array<{ id: string; subtreeCount: number }>;
  assert.equal(after.find(group => group.id === 'unfiled')?.subtreeCount, 0, 'nothing is left unfiled');
});

/**
 * A shelf row whose file is gone is not a book, so it is not 未分组 either.
 *
 * The scanner flags a vanished file (`missing = 1`) instead of deleting the row, so
 * `user_books` keeps naming books the grid refuses to draw. Counting those made the
 * chip read 284 over an empty list: the number and the grid have to come from one
 * definition of "a book on this shelf", or the chip lies about its own section.
 */
test('a shelf row with no readable file is counted nowhere', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();
  const books = [
    { id: 'readable', relPath: 'readable.epub', missing: 0 },
    { id: 'gone', relPath: 'gone.epub', missing: 1 },
  ];
  for (const [index, book] of books.entries()) {
    h.db.run(`INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
              VALUES(?,?,'epub',?,'作者',1,1)`, book.id, 'h-' + book.id, book.id);
    h.db.run(`INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen,missing)
              VALUES(?,?,?,100,1,1,1,?)`, 'f-' + book.id, book.id, book.relPath, book.missing);
    h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', owner.id, book.id, index);
  }

  const ids = (body: { items: Array<{ id: string }> }) => body.items.map(book => book.id).sort();
  const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json()
    .groups as Array<{ id: string; subtreeCount: number }>;
  assert.equal(listed.find(group => group.id === 'unfiled')?.subtreeCount, 1,
    'only the readable book counts');

  const unfiled = await h.app.inject({ method: 'GET', url: '/api/v1/books?groups=unfiled', headers: auth(owner) });
  assert.deepEqual(ids(unfiled.json()), ['readable'], 'the chip opens exactly what it counted');

  // Filing the dead row by hand does not make a group claim it either.
  const created = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: '读过' } });
  const groupId = created.json().group.id as string;
  await h.app.inject({ method: 'PUT', url: '/api/v1/books/gone/groups', headers: auth(owner), payload: { groupIds: [groupId] } });
  const after = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json()
    .groups as Array<{ id: string; subtreeCount: number }>;
  assert.equal(after.find(group => group.id === groupId)?.subtreeCount, 0, 'a book with no file is in no section');
  assert.equal(after.find(group => group.id === 'unfiled')?.subtreeCount, 1, 'and it does not reappear as 未分组');
});

/**
 * Each level answers its own question (篇幅, tag, tag 细分) and so gets its own
 * 或 / 与 / 非; the levels themselves are AND-ed.
 */
test('each level has its own 或 / 与 / 非, and the levels intersect', () => {
  const db = new Db(':memory:'), shelf = new ShelfService(db), groups = new GroupService(db);
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0)");
    const books = ['long-only', 'tag-book', 'sub-tag', 'college', 'short', 'elsewhere'];
    for (const [index, id] of books.entries()) {
      db.run(`INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
              VALUES(?,?,'epub',?,'作者',1,1)`, id, 'h-' + id, id);
      db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
        'f-' + id, id, `${id}.epub`);
      db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', 'u', id, index);
    }
    const top = groups.create('u', '大类');
    const long = groups.create('u', '长', { parentId: top.id, level: 2 });
    const short = groups.create('u', '短', { parentId: top.id, level: 2 });
    const tag = groups.create('u', '奇幻', { parentId: long.id, level: 3 });
    const college = groups.create('u', '学院', { parentId: top.id, level: 3 });
    const reborn = groups.create('u', '转生', { parentId: tag.id, level: 4 });
    const other = groups.create('u', '别处');
    groups.setForBook('u', 'long-only', [long.id]);
    groups.setForBook('u', 'tag-book', [tag.id]);
    groups.setForBook('u', 'sub-tag', [reborn.id]);
    groups.setForBook('u', 'college', [college.id]);
    groups.setForBook('u', 'short', [short.id]);
    groups.setForBook('u', 'elsewhere', [other.id]);

    const ids = (options: Parameters<ShelfService['list']>[1]) =>
      shelf.list('u', { ...options, pageSize: 50, sort: 'title', order: 'asc' }).items.map(book => book.id).sort();
    // 二级 或: either 篇幅.
    assert.deepEqual(ids({ groups: [long.id, short.id], groupModes: { 2: 'or' } }), ['long-only', 'short', 'sub-tag', 'tag-book']);
    // 二级 非: neither.
    assert.deepEqual(ids({ groups: [long.id], groupModes: { 2: 'not' } }), ['college', 'elsewhere', 'short']);
    // 三级 与 two tags: a book filed in both (the 四级 also belongs to its tag).
    assert.deepEqual(ids({ groups: [tag.id, college.id], groupModes: { 3: 'and' } }), []);
    // 三级 或.
    assert.deepEqual(ids({ groups: [tag.id, college.id], groupModes: { 3: 'or' } }), ['college', 'sub-tag', 'tag-book']);
    // 三级 非.
    assert.deepEqual(ids({ groups: [college.id], groupModes: { 3: 'not' } }), ['elsewhere', 'long-only', 'short', 'sub-tag', 'tag-book']);
    // 四级 非: the tag's own 细分 excluded, the tag itself still matches.
    assert.deepEqual(ids({ groups: [reborn.id], groupModes: { 4: 'not' } }), ['college', 'elsewhere', 'long-only', 'short', 'tag-book']);
    // Levels intersect: 篇幅 长 AND tag 转生.
    assert.deepEqual(ids({ groups: [long.id, reborn.id] }), ['sub-tag']);
    // …which is why 「篇幅 长」 + 「三级 非 学院」 is 长's books minus anything filed under 学院.
    assert.deepEqual(ids({ groups: [long.id, college.id], groupModes: { 3: 'not' } }), ['long-only', 'sub-tag', 'tag-book']);
    // The one-mode form older clients send still applies to every level.
    assert.deepEqual(ids({ groups: [long.id, short.id], groupMode: 'or' }), ['long-only', 'short', 'sub-tag', 'tag-book']);
  } finally { db.close(); }
});

/**
 * A folder tag carries the 篇幅 it sat in (「故事.长篇.喜剧」); the reader's tag may
 * not (「故事.-.喜剧」). Same 大类, same level, same last segment — one chip.
 */
test('a folder tag merges with the manual tag it means, even when the path differs', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();
  const books = [
    { id: 'manual', relPath: 'manual.epub' },
    { id: 'in-long', relPath: '故事/长篇/喜剧/一.epub' },
    { id: 'in-horror', relPath: '故事/恐怖/喜剧/二.epub' },
  ];
  for (const [index, book] of books.entries()) {
    h.db.run(`INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
              VALUES(?,?,'epub',?,'作者',1,1)`, book.id, 'h-' + book.id, book.id);
    h.db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
      'f-' + book.id, book.id, book.relPath);
    h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', owner.id, book.id, index);
  }
  const root = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: '故事' } });
  const rootId = root.json().group.id as string;
  const tag = await h.app.inject({
    method: 'POST', url: '/api/v1/groups', headers: auth(owner),
    payload: { name: '喜剧', parentId: rootId, level: 3 },
  });
  assert.equal(tag.statusCode, 201, tag.body);
  const tagId = tag.json().group.id as string;
  assert.equal(tag.json().group.name, '故事.-.喜剧');
  await h.app.inject({ method: 'PUT', url: '/api/v1/books/manual/groups', headers: auth(owner), payload: { groupIds: [tagId] } });

  const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json().groups as Array<{ id: string; name: string; level: number; folderIds?: string[]; subtreeCount: number }>;
  const merged = listed.find(group => group.id === tagId);
  assert.ok(merged, 'the manual tag is still the row that rename/delete address');
  assert.equal(merged.name, '故事.-.喜剧');
  assert.deepEqual(
    [...(merged.folderIds ?? [])].sort(),
    ['folder:故事/长篇/喜剧', 'folder:故事/恐怖/喜剧'].sort(),
  );
  assert.equal(merged.subtreeCount, 3, 'the hand-filed book and both folder books, each once');
  // The folder tags themselves are no longer chips of their own.
  assert.equal(listed.filter(group => group.level === 3).length, 1);
  // The chip's value joins its sources with `+`, which has to be %2B in a query
  // string (a bare `+` decodes to a space).
  const value = [tagId, ...(merged.folderIds ?? [])].map(encodeURIComponent).join('%2B');
  const filtered = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${value}`, headers: auth(owner) });
  assert.deepEqual(filtered.json().items.map((book: { id: string }) => book.id).sort(), ['in-horror', 'in-long', 'manual']);
});

interface Session { token: string; id: string }const auth = (session: Session) => ({ authorization: `Bearer ${session.token}` });

async function httpHarness() {
  const root = await mkdtemp(join(tmpdir(), 'reader-groups-api-'));
  const booksDir = join(root, 'books'), dataDir = join(root, 'data');
  await mkdir(booksDir);
  await mkdir(dataDir);
  const config: AppConfig = {
    booksDir, dataDir, host: '127.0.0.1', port: 0, jwtSecret: 'groups-api-test-secret-stable-enough',
    accessTokenTtl: 86400, refreshTokenTtl: 86400, scanInterval: 0, watchInterval: 0,
    logLevel: 'silent', publicUrl: '', corsOrigins: [], webDir: join(root, 'no-web'),
  };
  const db = openDatabase(config);
  const ctx = { config, db } as AppContext;
  const app: FastifyInstance = buildApp(ctx);
  ctx.log = app.log;
  ctx.scanner = new Scanner(db, config, { info() {}, warn() {} });
  ctx.users = new UserService(db, config);
  ctx.shelf = new ShelfService(db);
  ctx.groups = new GroupService(db);
  await app.ready();
  const register = async (): Promise<Session> => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { username: 'owner', password: 'password123' } });
    assert.equal(res.statusCode, 201, res.body);
    const body = res.json() as { session: { accessToken: string }; user: { id: string } };
    return { token: body.session.accessToken, id: body.user.id };
  };
  return {
    app, db, root, ctx, register,
    close: async () => { await app.close(); db.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test('group routes: CRUD, per-book assignment, and the shelf filter round-trip', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();

  // One book on the owner's shelf, so visibility checks have something to find.
  h.db.run(`INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
            VALUES('book-1','h1','epub','一本书','作者',1,1)`);
  h.db.run(`INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen)
            VALUES('file-1','book-1','book-1.epub',100,1,1,1)`);
  h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,0,0)', owner.id, 'book-1');

  const created = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: '科幻' } });
  assert.equal(created.statusCode, 201, created.body);
  const groupId = created.json().group.id as string;
  assert.equal(created.json().group.bookCount, 0);

  const duplicate = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: '科幻' } });
  assert.equal(duplicate.statusCode, 400);
  const missing = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: {} });
  assert.equal(missing.statusCode, 400);

  const renamed = await h.app.inject({ method: 'PATCH', url: `/api/v1/groups/${groupId}`, headers: auth(owner), payload: { name: '硬科幻' } });
  assert.equal(renamed.statusCode, 200, renamed.body);
  assert.equal(renamed.json().group.name, '硬科幻');

  const assigned = await h.app.inject({ method: 'PUT', url: '/api/v1/books/book-1/groups', headers: auth(owner), payload: { groupIds: [groupId] } });
  assert.equal(assigned.statusCode, 200, assigned.body);
  assert.deepEqual(assigned.json().book.groups, [{ id: groupId, name: '硬科幻', kind: 'manual' }]);

  const listed = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${groupId}`, headers: auth(owner) });
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].groups[0].name, '硬科幻');
  // A top-level group has no mode of its own, so 「非」 does not turn it into an
  // exclusion: the mode only reaches 二 / 三 / 四级 (see the level test below).
  const excluded = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${groupId}&groupMode=not`, headers: auth(owner) });
  assert.equal(excluded.json().items.length, 1);
  const bogus = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${groupId}&groupMode=xor`, headers: auth(owner) });
  assert.equal(bogus.statusCode, 400);

  // Another account cannot touch this group, and cannot file into it. (A new account
  // inherits the whole library, so the book itself is visible — the group is not.)
  const other = await h.app.inject({ method: 'POST', url: '/api/v1/admin/users', headers: auth(owner), payload: { username: 'guest', password: 'password123' } });
  assert.equal(other.statusCode, 201, other.body);
  const login = await h.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'guest', password: 'password123' } });
  const guest: Session = { token: login.json().accessToken, id: login.json().user.id };
  assert.equal((await h.app.inject({ method: 'PATCH', url: `/api/v1/groups/${groupId}`, headers: auth(guest), payload: { name: '偷改' } })).statusCode, 404);
  const guestAssign = await h.app.inject({ method: 'PUT', url: '/api/v1/books/book-1/groups', headers: auth(guest), payload: { groupIds: [groupId] } });
  assert.equal(guestAssign.statusCode, 400, guestAssign.body);
  assert.equal(guestAssign.json().error.code, 'GROUP_NOT_FOUND');
  const guestIsolation = await h.app.inject({ method: 'GET', url: '/api/v1/books', headers: auth(guest) });
  assert.deepEqual(guestIsolation.json().items[0].groups, [], 'group membership is per account');

  // The shelf's opening group is stored server-side, one per account.
  const madeDefault = await h.app.inject({ method: 'PUT', url: '/api/v1/groups/default', headers: auth(owner), payload: { groupId } });
  assert.equal(madeDefault.statusCode, 200, madeDefault.body);
  assert.equal(madeDefault.json().defaultGroupId, groupId);
  const withDefault = await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) });
  assert.equal(withDefault.json().groups.find((group: { id: string }) => group.id === groupId).isDefault, true);
  const clearedDefault = await h.app.inject({ method: 'PUT', url: '/api/v1/groups/default', headers: auth(owner), payload: { groupId: null } });
  assert.equal(clearedDefault.json().defaultGroupId, null);

  const removed = await h.app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}`, headers: auth(owner) });
  assert.equal(removed.statusCode, 200, removed.body);
  const afterDelete = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json().groups as Array<{ id: string; kind: string; name: string }>;
  assert.deepEqual(afterDelete.filter(group => group.kind === 'manual'), []);
  // 未分组 is not a stored group, so it survives every delete: it is the way back
  // to the books that were never filed.
  assert.deepEqual(afterDelete.map(group => group.name), ['未分组']);
  const afterRemoval = await h.app.inject({ method: 'GET', url: '/api/v1/books', headers: auth(owner) });
  assert.equal(afterRemoval.json().items.length, 1, 'the book stays on the shelf');
  assert.deepEqual(afterRemoval.json().items[0].groups, []);
});

/**
 * A page of the shelf is a screenful of *cards*: a 丛书 is one slot.
 *
 * Paging by book is what made a shelf of 172 books show eleven cards on page one:
 * the first sixty books were three 丛书 (35 + 13 + 4 volumes), so sixty rows became
 * eleven slots and two thirds of the page was empty. A page of 60 now means sixty
 * *slots*, and a 丛书's volumes travel together — the client's fold never has to
 * guess, and one series can never be split across two pages.
 *
 * The library browser keeps paging by book: it is a folder listing, not a shelf.
 */
test('the shelf pages by slot, so a 丛书 cannot eat a whole page', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();
  const books = [
    { id: 'a1', title: 'A1', series: 'Alpha Saga' },
    { id: 'a2', title: 'A2', series: 'Alpha Saga' },
    { id: 'a3', title: 'A3', series: 'Alpha Saga' },
    { id: 'y1', title: 'Yak' },
    { id: 'z1', title: 'Zed' },
  ];
  for (const [index, book] of books.entries()) {
    h.db.run(
      `INSERT INTO books(id,content_hash,format,title,author,series,created_at,updated_at)
       VALUES(?,?,'epub',?,'作者',?,1,1)`,
      book.id, 'h-' + book.id, book.title, book.series ?? '',
    );
    h.db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
      'f-' + book.id, book.id, book.id + '.epub');
    h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', owner.id, book.id, index);
  }

  const page = async (query: string) => {
    const res = await h.app.inject({ method: 'GET', url: `/api/v1/books?${query}`, headers: auth(owner) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { items: Array<{ id: string }>; total: number; bookTotal?: number };
  };

  // By title: 「Alpha Saga」 (A1–A3, one slot) · Yak · Zed.
  const first = await page('sort=title&order=asc&pageSize=2&page=1');
  assert.equal(first.total, 3, 'three slots, not five books');
  assert.equal(first.bookTotal, 5, 'and the reader still has five books');
  assert.deepEqual(first.items.map(book => book.id), ['a1', 'a2', 'a3', 'y1'],
    'the whole 丛书 comes with its slot');

  const second = await page('sort=title&order=asc&pageSize=2&page=2');
  assert.deepEqual(second.items.map(book => book.id), ['z1'], 'the next page starts after that slot');

  // The library browser lists a folder, so it pages by book.
  const library = await page('scope=library&sort=title&order=asc&pageSize=2&page=1');
  assert.equal(library.total, 5);
  assert.deepEqual(library.items.map(book => book.id), ['a1', 'a2'], 'no folding in the library scope');
});

/**
 * A group's number is a card count, not a file count.
 *
 * 「轻小说 55」 over a grid of six cards is the same complaint as the empty page:
 * the number describes something the reader cannot see. So every group carries both
 * readings — `bookCount`/`subtreeCount` for files, `slotCount`/`subtreeSlotCount`
 * for cards, one per 丛书 — and 书架 settings picks which one the chips draw
 * (「丛书算一本」, on by default).
 */
test('a group reports both readings: books, and slots that count a 丛书 once', async t => {
  const h = await httpHarness();
  t.after(() => h.close());
  const owner = await h.register();
  const books = [
    { id: 's1', title: 'A1', series: 'Alpha Saga' },
    { id: 's2', title: 'A2', series: 'Alpha Saga' },
    { id: 's3', title: 'A3', series: 'Alpha Saga' },
    { id: 'loose', title: 'Zed' },
    { id: 'u1', title: 'B1', series: 'Beta Saga' },
    { id: 'u2', title: 'B2', series: 'Beta Saga' },
  ];
  for (const [index, book] of books.entries()) {
    h.db.run(
      `INSERT INTO books(id,content_hash,format,title,author,series,created_at,updated_at)
       VALUES(?,?,'epub',?,'作者',?,1,1)`,
      book.id, 'h-' + book.id, book.title, book.series ?? '',
    );
    h.db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
      'f-' + book.id, book.id, book.id + '.epub');
    h.db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', owner.id, book.id, index);
  }

  const created = await h.app.inject({ method: 'POST', url: '/api/v1/groups', headers: auth(owner), payload: { name: '轻小说' } });
  const groupId = created.json().group.id as string;
  for (const bookId of ['s1', 's2', 's3', 'loose']) {
    const res = await h.app.inject({ method: 'PUT', url: `/api/v1/books/${bookId}/groups`, headers: auth(owner), payload: { groupIds: [groupId] } });
    assert.equal(res.statusCode, 200, res.body);
  }

  const listed = (await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json()
    .groups as Array<{ id: string; bookCount: number; slotCount: number; subtreeCount: number; subtreeSlotCount: number }>;
  const filed = listed.find(group => group.id === groupId)!;
  assert.equal(filed.bookCount, 4, 'four files');
  assert.equal(filed.slotCount, 2, 'one 丛书 + one loose book');
  assert.equal(filed.subtreeCount, 4);
  assert.equal(filed.subtreeSlotCount, 2);

  // 未分组 carries both too: two volumes of one 丛书 are one card.
  const unfiled = listed.find(group => group.id === 'unfiled')!;
  assert.equal(unfiled.bookCount, 2);
  assert.equal(unfiled.slotCount, 1);
});
