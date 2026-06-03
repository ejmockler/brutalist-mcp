// Capstone test for the claude+codex+agy panel (codex via the noot-1 broker).
// Intentionally flawed so all three critics have something to find. Do not merge.
function pay(db, user, amt) {
  const q = "UPDATE accounts SET bal = bal - " + amt + " WHERE u='" + user + "'";
  db.exec(q);                 // SQL injection + no tx + no balance check
  return db.exec("SELECT bal FROM accounts WHERE u='" + user + "'").bal;
}
module.exports = { pay };
