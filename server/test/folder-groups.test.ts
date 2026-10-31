import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db/index.ts';
import { ShelfService } from '../src/services/shelf.ts';
import { GroupService, UNFILED_GROUP_ID } from '../src/services/groups.ts';
import {
  folderGroupDir,
  folderGroupOf,
  folderGroupPathOf,
  folderGroups,
  isFolderGroupId,
} from '../src/services/folder-groups.ts';

/**
 * 「未分组」 is a filter, not a group: it selects the books that sit in none of the
 * reader's own groups. Folder groups do not count as filing — they say where the
 * file is, not what the reader decided — so a book filed only by its folder still
 * shows up here.
 */
test('未分组 is always offered and selects the books with no manual group', () => {
  const db = new Db(':memory:'), shelf = new ShelfService(db), groups = new GroupService(db);
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0)");
    for (const [index, id] of ['filed', 'bare', 'in-folder'].entries()) {
      db.run(
        `INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
         VALUES(?,?,'epub',?,'作者',1,?)`, id, 'h-' + id, id, index + 1,
      );
      db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)',
        'f-' + id, id, id === 'in-folder' ? '故事/长篇/x.epub' : `${id}.epub`);
      db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,?,0)', 'u', id, index);
    }
    const filing = groups.create('u', '小说');
    groups.setForBook('u', 'filed', [filing.id]);

    const unfiled = groups.unfiled('u');
    assert.equal(unfiled.id, UNFILED_GROUP_ID);
    assert.equal(unfiled.name, '未分组');
    assert.equal(unfiled.level, 1);
    assert.equal(unfiled.kind, 'unfiled');
    assert.equal(unfiled.subtreeCount, 2, 'bare + in-folder: a folder is not a filing');

    const ids = (options: Parameters<ShelfService['list']>[1]) =>
      shelf.list('u', { ...options, pageSize: 50, sort: 'title', order: 'asc' }).items.map(book => book.id).sort();
    assert.deepEqual(ids({ groups: [UNFILED_GROUP_ID] }), ['bare', 'in-folder']);
    assert.deepEqual(ids({ groups: [filing.id] }), ['filed']);
    // 未分组 is a top-level condition, and the top level has no 或 / 与 / 非 of its own:
    // 「非 未分组」 would need a mode the top level does not take.
    assert.deepEqual(ids({ groups: [UNFILED_GROUP_ID], groupMode: 'not' }), ['bare', 'in-folder']);
    // Two top-level conditions intersect: a book is both filed and unfiled never.
    assert.deepEqual(ids({ groups: [filing.id, UNFILED_GROUP_ID] }), [], 'top-level conditions intersect');
    // It is a filter, never a place to put a book.
    groups.setForBook('u', 'bare', [UNFILED_GROUP_ID]);
    assert.deepEqual(groups.idsOf('u', 'bare'), []);
    // A book taken off the shelf stops counting, like every other group count.
    db.run("UPDATE user_books SET hidden = 1 WHERE user_id = 'u' AND book_id = 'bare'");
    assert.equal(groups.unfiled('u').subtreeCount, 1);
  } finally { db.close(); }
});

/**
 * Folder groups: a book's folders are its groups, read from `book_files.rel_path`
 * and never stored. The first three folder levels below BOOKS_DIR name the group
 * and a book sits at the deepest of them; anything deeper joins its third level.
 */
test('folder groups are derived from the file layout and filter the shelf', () => {
  const db = new Db(':memory:'), shelf = new ShelfService(db), groups = new GroupService(db);
  try {
    db.run("INSERT INTO users(id,username,password_hash,role,created_at,updated_at) VALUES('u','reader','x','member',0,0)");
    /** rel_path as the scanner stores it: relative to BOOKS_DIR, '/'-separated. */
    const files: Record<string, string> = {
      'deep-1': '故事/长篇/喜剧/一.epub',
      'deep-2': '故事/长篇/喜剧/外传/二.epub',
      'shallow': '故事/随笔.epub',
      'root': '顶层.epub',
      'dotted': '画集/Vol.1/设定.epub',
    };
    for (const [id, relPath] of Object.entries(files)) {
      db.run(
        `INSERT INTO books(id,content_hash,format,title,author,created_at,updated_at)
         VALUES(?,?,'epub',?,'作者',1,1)`, id, 'h-' + id, id,
      );
      db.run('INSERT INTO book_files(id,book_id,rel_path,size,mtime_ms,first_seen,last_seen) VALUES(?,?,?,100,1,1,1)', 'f-' + id, id, relPath);
      db.run('INSERT INTO user_books(user_id,book_id,added_at,hidden) VALUES(?,?,0,0)', 'u', id);
    }

    // --- the path a file turns into ---
    assert.deepEqual(folderGroupOf('故事/长篇/喜剧/一.epub'), { id: 'folder:故事/长篇/喜剧', name: '故事.长篇.喜剧' });
    assert.equal(folderGroupPathOf('顶层.epub'), null, 'a book at the library root is unfiled');
    // More than three folders: the first three name the group, deeper files join it.
    assert.equal(folderGroupPathOf('故事/长篇/喜剧/外传/二.epub'), '故事.长篇.喜剧');
    // A dot inside a folder name would read as a level, so it is re-spelled.
    assert.equal(folderGroupPathOf('画集/Vol.1/设定.epub'), '画集.Vol·1');
    assert.equal(isFolderGroupId('folder:故事/长篇'), true);
    assert.equal(isFolderGroupId('3f2a-uuid'), false);
    assert.equal(folderGroupDir('folder:故事/长篇'), '故事/长篇');
    assert.equal(folderGroupDir('3f2a-uuid'), null);

    // --- the list the shelf draws (one count per chip) ---
    const listed = new Map(folderGroups(db).map(group => [group.name, group]));
    assert.deepEqual([...listed.keys()].sort(), ['故事', '故事.长篇', '故事.长篇.喜剧', '画集', '画集.Vol·1'].sort());
    assert.equal(listed.get('故事')?.level, 1);
    assert.equal(listed.get('故事.长篇')?.parentId, 'folder:故事');
    assert.equal(listed.get('故事')?.bookCount, 1, 'only 随笔 sits directly in 故事');
    assert.equal(listed.get('故事')?.subtreeCount, 3, 'the whole subtree, de-duplicated');
    assert.equal(listed.get('故事.长篇.喜剧')?.bookCount, 2);
    assert.equal(listed.get('故事.长篇.喜剧')?.level, 3);
    assert.equal(listed.get('画集.Vol·1')?.bookCount, 1);

    // --- the shelf filter: a folder group includes everything below it ---
    const ids = (options: Parameters<ShelfService['list']>[1]) =>
      shelf.list('u', { ...options, pageSize: 50, sort: 'title', order: 'asc' }).items.map(book => book.id).sort();
    assert.deepEqual(ids({ groups: ['folder:故事'] }), ['deep-1', 'deep-2', 'shallow']);
    assert.deepEqual(ids({ groups: ['folder:故事/长篇'] }), ['deep-1', 'deep-2']);
    assert.deepEqual(ids({ groups: ['folder:故事/长篇/喜剧'] }), ['deep-1', 'deep-2'], 'deeper folders join the third level');
    assert.deepEqual(ids({ groups: ['folder:画集/Vol.1'] }), ['dotted'], 'the id keeps the raw folder path');
    // A folder group is top-level too, so it is a plain condition (no 非).
    assert.deepEqual(ids({ groups: ['folder:故事'], groupMode: 'not' }), ['deep-1', 'deep-2', 'shallow']);
    assert.deepEqual(ids({ groups: ['folder:故事', 'folder:画集'], groupMode: 'and' }), [], 'and needs one book in both');

    // --- folder and manual groups combine in one filter ---
    const manual = groups.create('u', '想读');
    groups.setForBook('u', 'root', [manual.id]);
    // 一级组之间没有 或 / 与 / 非，两个一级条件取交集：一本书既在手动组里又在
    // 文件夹里才会命中。
    assert.deepEqual(ids({ groups: [manual.id, 'folder:画集'] }), [], 'top-level conditions intersect');
    assert.deepEqual(ids({ groups: [manual.id], groupMode: 'not' }), ['root'], 'a top-level group has no mode');
    assert.deepEqual(ids({ groups: ['folder:不存在'] }), [], 'a folder that holds nothing matches nothing');

    // --- a book carries its folder group back for 书籍详情 ---
    const dto = shelf.get('u', 'deep-1');
    assert.deepEqual(dto.groups?.filter(group => group.kind === 'folder'), [
      { id: 'folder:故事/长篇/喜剧', name: '故事.长篇.喜剧', kind: 'folder' },
    ]);
    assert.deepEqual(shelf.get('u', 'root').groups?.filter(group => group.kind === 'folder'), []);
    // Writing a book's groups never stores the derived ones: they are read-only.
    groups.setForBook('u', 'deep-1', ['folder:故事/长篇', manual.id]);
    assert.deepEqual(groups.idsOf('u', 'deep-1'), [manual.id]);

    // --- the chips count this reader's shelf, not the whole library ---
    db.run("UPDATE user_books SET hidden = 1 WHERE user_id = 'u' AND book_id = 'dotted'");
    const onShelf = new Map(folderGroups(db, 'u').map(group => [group.name, group]));
    const inLibrary = new Map(folderGroups(db).map(group => [group.name, group]));
    assert.equal(onShelf.has('画集'), false, 'a folder with nothing on this shelf is not a chip');
    assert.equal(inLibrary.get('画集')?.subtreeCount, 1, 'the library still holds it');
  } finally { db.close(); }
});
