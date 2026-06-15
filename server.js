const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const md5 = require('crypto').createHash;
const db = require('./db');
const Zalopay = require('./core/zalopay');
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
const PORT = 8000;
app.use(express.static('public'));
app.get('/api/accounts', async (req, res) => {
    try {
        const accounts = await db.getAccounts();
        res.json({ status: 'success', data: accounts });
    } catch (e) {
        res.json({ status: 'error', msg: e.message });
    }
});
function randomString(length) {
    let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let str = '';
    for (let i = 0; i < length; i++) str += chars.charAt(Math.floor(Math.random() * chars.length));
    return str;
}
app.post('/api.php', async (req, res) => {
    try {
        const action = req.body.action || '';
        const z = new Zalopay();
        switch (action) {
            case 'LOGIN': {
                const { phone, password, cookie } = req.body;
                if (!phone || !password || !cookie) {
                    return res.json({ status: 'error', msg: 'Vui lòng nhập đầy đủ: SĐT, Mật khẩu, Cookie' });
                }
                const token_api = md5('md5').update(randomString(6) + Date.now()).digest('hex');
                let account = await db.getAccountByPhone(phone);
                if (account) {
                    account.type_api = 'web';
                    account.cookie = cookie;
                    account.status = 'pending';
                } else {
                    account = {
                        phone, type_api: 'web', cookie, status: 'pending', userID: 1, token_api, id: Date.now().toString()
                    };
                }
                await db.saveAccount(account);
                z.loadData(account);
                const info = await z.ZaloLogin_Cookie();
                if (!info.error && info.data) {
                    account.password = password;
                    account.name = info.data.display_name;
                    account.avatar = info.data.avatar;
                    account.zalo_id = info.data.zalo_id;
                    account.user_id = info.data.zalopay_id;
                    account.profile_level = info.data.profile_level;
                    account.status = 'success';
                    account.errorDesc = 'Thành Công';
                    account.time_login = Math.floor(Date.now() / 1000);
                    const balanceReq = await z.getBalance_web();
                    if (balanceReq?.data?.balance !== undefined) {
                        account.balance = balanceReq.data.balance;
                    }
                    await db.saveAccount(account);
                    return res.json({ status: 'success', msg: 'Đăng nhập thành công' });
                } else {
                    account.status = 'error';
                    account.errorDesc = 'Cookie Không Hợp Lệ';
                    await db.saveAccount(account);
                    return res.json({ status: 'error', msg: 'Cookie Không Hợp Lệ hoặc Lỗi login' });
                }
            }
            case 'RELOADBALANCE': {
                const { id } = req.body;
                const account = await db.getAccountById(id);
                if (!account) return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
                z.loadData(account);
                const balanceReq = await z.getBalance_web();
                if (!balanceReq.error) {
                    const month = new Date().getMonth() + 1;
                    const year = new Date().getFullYear();
                    const revenue = await z.income_outcome_web(month, year);
                    if (revenue?.data?.income_outcome?.length > 0) {
                        account.receive_mon = revenue.data.income_outcome[0].income_amount || 0;
                        account.ex_mon = revenue.data.income_outcome[0].outcome_amount || 0;
                    }
                    if (balanceReq.data?.balance !== undefined) {
                        account.balance = balanceReq.data.balance;
                    }
                    await db.saveAccount(account);
                    return res.json({ status: 'success', msg: `Cập nhật số dư thành công: ${account.balance}đ` });
                } else {
                    account.status = 'out';
                    account.errorDesc = 'Cookie Die';
                    await db.saveAccount(account);
                    return res.json({ status: 'error', msg: 'Lỗi lấy số dư (Cookie có thể đã chết)' });
                }
            }
            case 'history': {
                const { phone } = req.body;
                const account = await db.getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Không tìm thấy tài khoản', transactions: [] });
                z.loadData(account);
                const history = await z.getTransactions2();
                return res.json(history);
            }
            case 'update': {
                const { phone, cookie } = req.body;
                if (!phone || !cookie) return res.json({ status: 'error', msg: 'Thiếu thông tin' });
                const account = await db.getAccountByPhone(phone);
                if (account) {
                    account.cookie = cookie;
                    account.time_login = Math.floor(Date.now() / 1000);
                    account.status = 'pending';
                    await db.saveAccount(account);
                    return res.json({ status: 'success', msg: 'Cập nhật cookie thành công' });
                }
                return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
            }
            case 'REMOVE': {
                const { id } = req.body;
                await db.removeAccount(id);
                return res.json({ status: 'success', msg: 'Đã xóa tài khoản' });
            }
            case 'transfer': {
                const { receiver, account: phone, amount, comment, password } = req.body;
                if (!receiver || !phone || !amount || !password) return res.json({ status: 'error', msg: 'Nhập thiếu thông tin chuyển tiền' });
                const account = await db.getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
                if (account.password !== password) return res.json({ status: 'error', msg: 'Mật khẩu sai' });
                z.loadData(account);
                const send = await z.SendMoney_web(receiver, comment, amount);
                if (send.status === 'error') {
                    return res.json({ status: 'error', msg: send.message });
                } else {
                    const balanceReq = await z.getBalance_web();
                    if (!balanceReq.error && balanceReq.data?.balance !== undefined) {
                        account.balance = balanceReq.data.balance;
                        await db.saveAccount(account);
                    }
                    await db.logTransaction({
                        type_gd: 'sendmoney', tranId: send.data.zp_trans_id,
                        partnerId: receiver, amount, comment, status: 'success',
                        message: 'Chuyển Tiền Thành Công', user_id: 1
                    });
                    return res.json({ status: 'success', msg: `Chuyển thành công. Số dư: ${account.balance || 0}` });
                }
            }
            case 'CreateQR': {
                const { id, amount } = req.body;
                const account = await db.getAccountById(id);
                if (!account) return res.json({ status: 'error', msg: 'Acc không tồn tại' });
                z.loadData(account);
                const qr = await z.Create_QR_web(amount, '');
                return res.json({ status: 'success', msg: 'OK', data: qr });
            }
            case 'NameBank': {
                const { phone, stk, bank } = req.body; 
                const account = await db.getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Acc không tồn tại' });
                const data_config = bank.split('-');
                z.loadData(account);
                const nameInfo = await z.get_name_bank_web(stk, data_config[1]);
                if (nameInfo.error || !nameInfo.bank_holder_name) {
                    return res.json({ status: 'error', msg: 'Lỗi không xác định hoặc không tìm thấy tên' });
                }
                return res.json({ status: 'success', msg: nameInfo.bank_holder_name, data: nameInfo });
            }
            case 'transfer_bank': {
                const { account: phone, stk, bank, amount, comment, password, name } = req.body;
                if (!phone || !stk || !amount || !password) return res.json({ status: 'error', msg: 'Thiếu thông tin' });
                const account = await db.getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Acc lỗi' });
                if (account.password !== password) return res.json({ status: 'error', msg: 'Sai mật khẩu' });
                const data_bank = bank.split('-');
                const config_bank = { bankcode: data_bank[1], bcbankcode: data_bank[0] };
                z.loadData(account);
                const send = await z.SendMoney_Bank_web(stk, amount, comment, config_bank);
                if (send.status === 'error') {
                    return res.json({ status: 'error', msg: send.message });
                } else {
                    const balanceReq = await z.getBalance_web();
                    if (!balanceReq.error && balanceReq.data?.balance !== undefined) {
                        account.balance = balanceReq.data.balance;
                        await db.saveAccount(account);
                    }
                    await db.logTransaction({
                        type_gd: 'sendbank', tranId: send.data.zp_trans_id,
                        partnerId: stk, partnerName: name, amount, comment, status: 'success',
                        user_id: 1
                    });
                    return res.json({ status: 'success', msg: `Chuyển Bank thành công. Số dư: ${account.balance || 0}` });
                }
            }
            case 'ANTI': {
                const { phone, status, ip } = req.body;
                const account = await db.getAccountByPhone(phone);
                if (account) {
                    account.ip_white = ip;
                    account.status_ip_white = status;
                    await db.saveAccount(account);
                    return res.json({ status: 'success', msg: 'Cập nhật cấu hình IP thành công' });
                }
                return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
            }
            default: return res.json({ status: 'error', msg: 'Unknown Action' });
        }
    } catch (e) {
        return res.json({ status: 'error', msg: `Lỗi Server: ${e.message}`, stack: e.stack });
    }
});
app.use(express.static('public'));
app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZaloPay Node.js API is running on http://0.0.0.0:${PORT}`);
});
