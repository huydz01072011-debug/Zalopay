const fs = require('fs').promises;
const path = require('path');
const DB_PATH = path.join(__dirname, 'db.json');
async function readDB() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf-8');
        const parsed = JSON.parse(data || '{"accounts":[],"transactions":[]}');
        if (!parsed.accounts) parsed.accounts = [];
        if (!parsed.transactions) parsed.transactions = [];
        return parsed;
    } catch (e) {
        if (e.code === 'ENOENT') {
            const initial = { accounts: [], transactions: [] };
            await writeDB(initial);
            return initial;
        }
        throw e;
    }
}
async function writeDB(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}
async function getAccounts() {
    const db = await readDB();
    return db.accounts;
}
async function getAccountByPhone(phone) {
    const accounts = await getAccounts();
    return accounts.find(acc => acc.phone === phone) || null;
}
async function getAccountById(id) {
    const accounts = await getAccounts();
    return accounts.find(acc => acc.id === id) || null;
}
async function saveAccount(accountData) {
    const db = await readDB();
    const index = db.accounts.findIndex(acc => acc.phone === accountData.phone);
    if (index !== -1) {
        db.accounts[index] = { ...db.accounts[index], ...accountData };
    } else {
        accountData.id = accountData.id || Date.now().toString();
        db.accounts.push(accountData);
    }
    await writeDB(db);
    return true;
}
async function removeAccount(id) {
    const db = await readDB();
    db.accounts = db.accounts.filter(acc => acc.id !== id);
    await writeDB(db);
    return true;
}
async function logTransaction(transactionData) {
    const db = await readDB();
    db.transactions.push({
        id: Date.now().toString(),
        time: Math.floor(Date.now() / 1000),
        date_time: new Date().toLocaleDateString('en-GB'),
        ...transactionData
    });
    await writeDB(db);
    return true;
}
async function getTransactions() {
    const db = await readDB();
    return db.transactions;
}
module.exports = {
    readDB,
    writeDB,
    getAccounts,
    getAccountByPhone,
    getAccountById,
    saveAccount,
    removeAccount,
    logTransaction,
    getTransactions
};
