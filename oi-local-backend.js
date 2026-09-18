/* Opening Intelligence bounded local provider.
 * Stores real user-entered records in this browser only. No recognition data
 * is seeded, no network call is made, and this is not a production schema.
 */

const NS = 'oi_local_';
const LOCAL_USER = { id: 'local-user', email: 'local-only@opening-intelligence.invalid' };

function read(table) {
  try { return JSON.parse(localStorage.getItem(NS + table) || '[]'); }
  catch (_) { return []; }
}

function write(table, rows) {
  localStorage.setItem(NS + table, JSON.stringify(rows));
}

function makeId(prefix) {
  try { return prefix + '-' + crypto.randomUUID(); }
  catch (_) { return prefix + '-' + Date.now() + '-' + Math.random().toString(16).slice(2); }
}

function ensureBaseRecords() {
  const profiles = read('profiles');
  if (!profiles.some((row) => row.id === LOCAL_USER.id)) {
    profiles.push({ id: LOCAL_USER.id, user_type: 'vendor', local_only: true });
    write('profiles', profiles);
  }
}

function response(data, error) {
  return { data: data == null ? null : data, error: error || null, status: error ? 400 : 200 };
}

function query(tableName) {
  const predicates = [];
  let limitValue = null;
  let mutation = null;
  let singleMode = false;

  function filtered(rows) {
    let out = rows.filter((row) => predicates.every((predicate) => predicate(row)));
    if (limitValue != null) out = out.slice(0, limitValue);
    if (tableName === 'memberships') {
      const facilities = read('facilities');
      out = out.map((row) => Object.assign({}, row, {
        facilities: facilities.find((facility) => facility.id === row.facility_id) || null,
      }));
    }
    return out;
  }

  function execute() {
    try {
      let rows = read(tableName);
      let result;
      if (!mutation) {
        result = filtered(rows);
      } else if (mutation.type === 'insert') {
        const incoming = (Array.isArray(mutation.rows) ? mutation.rows : [mutation.rows]).map((row) => {
          const copy = Object.assign({}, row);
          if (!copy.id && tableName === 'facilities') copy.id = makeId('facility');
          if (!copy.id && tableName === 'openings') copy.id = makeId('opening-row');
          return copy;
        });
        rows = rows.concat(incoming);
        write(tableName, rows);
        result = incoming;
      } else if (mutation.type === 'upsert') {
        const incoming = Array.isArray(mutation.rows) ? mutation.rows : [mutation.rows];
        const saved = [];
        incoming.forEach((row) => {
          const copy = Object.assign({}, row);
          if (!copy.id && tableName === 'openings') copy.id = makeId('opening-row');
          const index = mutation.keys.length
            ? rows.findIndex((candidate) => mutation.keys.every((key) => candidate[key] === copy[key]))
            : -1;
          if (index >= 0) rows[index] = Object.assign({}, rows[index], copy);
          else rows.push(copy);
          saved.push(index >= 0 ? rows[index] : copy);
        });
        write(tableName, rows);
        result = saved;
      } else if (mutation.type === 'update') {
        const matches = filtered(rows);
        rows = rows.map((row) => matches.includes(row) ? Object.assign({}, row, mutation.row) : row);
        write(tableName, rows);
        result = filtered(rows);
      } else if (mutation.type === 'delete') {
        const matches = filtered(rows);
        rows = rows.filter((row) => !matches.includes(row));
        write(tableName, rows);
        result = matches;
      }
      return Promise.resolve(response(singleMode ? (result[0] || null) : result));
    } catch (error) {
      return Promise.resolve(response(null, { message: error.message || String(error) }));
    }
  }

  const api = {
    select() { return api; },
    eq(column, value) { predicates.push((row) => row && row[column] === value); return api; },
    in(column, values) { const set = new Set(values || []); predicates.push((row) => row && set.has(row[column])); return api; },
    order() { return api; },
    limit(value) { limitValue = value; return api; },
    maybeSingle() { singleMode = true; return execute(); },
    single() { singleMode = true; return execute(); },
    insert(rows) { mutation = { type: 'insert', rows }; return api; },
    upsert(rows, options) {
      mutation = {
        type: 'upsert', rows,
        keys: String((options && options.onConflict) || '').split(',').map((s) => s.trim()).filter(Boolean),
      };
      return api;
    },
    update(row) { mutation = { type: 'update', row }; return api; },
    delete() { mutation = { type: 'delete' }; return api; },
    then(resolve, reject) { return execute().then(resolve, reject); },
    catch(reject) { return execute().catch(reject); },
  };
  return api;
}

export function createClient() {
  ensureBaseRecords();
  let signedIn = true;
  return {
    __oiLocalMode: true,
    auth: {
      getSession: () => Promise.resolve(response({ session: signedIn ? { user: LOCAL_USER } : null })),
      signInWithPassword: () => { signedIn = true; return Promise.resolve(response({ user: LOCAL_USER })); },
      signOut: () => { signedIn = false; return Promise.resolve(response(null)); },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    from: query,
    storage: {
      from: () => ({
        upload: () => Promise.resolve(response(null, { message: 'Photos are not persisted in local-only mode.' })),
        getPublicUrl: () => ({ data: { publicUrl: null } }),
      }),
    },
  };
}
