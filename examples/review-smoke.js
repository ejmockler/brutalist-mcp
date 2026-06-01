// Dogfood smoke test for the Brutalist Review action. Intentionally flawed
// so the critics have something concrete to find. Not merged.
function getUser(db, id) {
  const q = "SELECT * FROM users WHERE id = '" + id + "'";
  return db.query(q).rows[0];
}

module.exports = { getUser };
