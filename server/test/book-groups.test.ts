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
    assert.deepEqual(ids({ groups: [scifi.id], groupMode: 'not' }), ['plain']);
    assert.deepEqual(ids({ groups: [scifi.id, later.id], groupMode: 'not' }), ['plain']);
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

interface Session { token: string; id: string }
const auth = (session: Session) => ({ authorization: `Bearer ${session.token}` });

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
  assert.deepEqual(assigned.json().book.groups, [{ id: groupId, name: '硬科幻' }]);

  const listed = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${groupId}`, headers: auth(owner) });
  assert.equal(listed.json().items.length, 1);
  assert.equal(listed.json().items[0].groups[0].name, '硬科幻');
  const excluded = await h.app.inject({ method: 'GET', url: `/api/v1/books?groups=${groupId}&groupMode=not`, headers: auth(owner) });
  assert.equal(excluded.json().items.length, 0);
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

  const removed = await h.app.inject({ method: 'DELETE', url: `/api/v1/groups/${groupId}`, headers: auth(owner) });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual((await h.app.inject({ method: 'GET', url: '/api/v1/groups', headers: auth(owner) })).json().groups, []);
  const afterRemoval = await h.app.inject({ method: 'GET', url: '/api/v1/books', headers: auth(owner) });
  assert.equal(afterRemoval.json().items.length, 1, 'the book stays on the shelf');
  assert.deepEqual(afterRemoval.json().items[0].groups, []);
});
