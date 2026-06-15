// ==================== FILE: server.js (GỘP TOÀN BỘ - ĐÃ SỬA LỊCH SỬ) ====================
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// ========================== CLASS ZALOPAY ==========================
class Zalopay {
    constructor() {
        this.config = {};
    }
    loadData(data) {
        this.config = data;
        return this;
    }
    sha256(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }
    getZaloHeader(isSapi = true) {
        return {
            'Cookie': this.config.cookie || '',
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
            'Accept-Language': 'vi-VN,vi;q=0.9',
            ...(isSapi ? { 'Host': 'sapi.zalopay.vn' } : {})
        };
    }
    async getRequest(url, headers = {}) {
        try {
            const response = await axios.get(url, { headers: { ...this.getZaloHeader(), ...headers } });
            return response.data;
        } catch (e) {
            return e.response ? e.response.data : { error: e.message };
        }
    }
    async postRequest(url, data, isPlain = false) {
        try {
            const h = this.getZaloHeader();
            if (isPlain) {
                h['Content-Type'] = 'text/plain;charset=UTF-8';
                data = JSON.stringify(data);
            }
            const response = await axios.post(url, data, { headers: h });
            return response.data;
        } catch (e) {
            return e.response ? e.response.data : { error: e.message };
        }
    }
    async ZaloLogin_Cookie() {
        return await this.getRequest('https://sapi.zalopay.vn/v2/user/profile/kyc', {
            'Referer': `https://social.zalopay.vn/spa/v2?c=1&c_time=${Date.now()}`
        });
    }
    async getBalance_web() {
        return await this.getRequest('https://api.zalopay.vn/v2/user/balance', { 'Host': 'api.zalopay.vn' });
    }
    async income_outcome_web(month, year) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/income-outcome?days=5&months=${month}&year=${year}`);
    }
    async getHistoryV2_filter(limit, page_token, month) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/transactions?page_size=${limit}&page_token=${page_token || ''}&filter_month=${month}`);
    }
    async getHistoryV2_web(limit, page_token) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/transactions?page_size=${limit}&page_token=${page_token || ''}`);
    }
    async GET_TRANS_BY_TID_WEB(app_trans_id) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/transactions/${app_trans_id}?type=1`);
    }
    async History_full_filter(limit, month) {
        const transList = [];
        const res = await this.getHistoryV2_filter(limit, '', month);
        if (!res || !res.data || !res.data.transactions) {
            return { status: 'error', code: -5, message: 'Lỗi API hoặc Cookie hết hạn', data: res };
        }
        for (let tx of res.data.transactions) {
            if (tx.status_info.status !== 1) continue;
            const det = await this.GET_TRANS_BY_TID_WEB(tx.trans_id);
            if (!det || !det.data || !det.data.transaction) continue;
            const t = det.data.transaction;
            transList.push({
                trans_id: t.trans_id,
                order_code: t.app_trans_id,
                info: t.template_info?.custom_fields || [],
                sign: t.sign || "",
                balance_snapshot: tx.balance_snapshot || 0,
                trans_amount: t.trans_amount || 0,
                description: t.description || "",
                trans_time: t.trans_time || "",
                app_trans_id: t.app_trans_id || ""
            });
        }
        return { status: "success", zalopayMsg: transList };
    }
    async getTransactions2() {
        try {
            // Lấy nhiều trang để có đủ lịch sử
            let allTransactions = [];
            let pageToken = '';
            let hasMore = true;
            let maxPages = 5; // giới hạn 5 trang (khoảng 100 giao dịch)
            let pageCount = 0;
            
            while (hasMore && pageCount < maxPages) {
                const url = pageToken 
                    ? `https://sapi.zalopay.vn/v2/history/transactions?page_size=20&page_token=${encodeURIComponent(pageToken)}`
                    : 'https://sapi.zalopay.vn/v2/history/transactions?page_size=20';
                
                const headers = {
                    'Cookie': this.config.cookie || '',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
                };
                const response = await axios.get(url, { headers });
                const data = response.data;
                
                if (data && data.data && Array.isArray(data.data.transactions)) {
                    for (let tx of data.data.transactions) {
                        if (tx.trans_id) {
                            allTransactions.push(tx);
                        }
                    }
                    // Kiểm tra trang tiếp theo
                    pageToken = data.data.next_page_token || '';
                    hasMore = !!pageToken && data.data.transactions.length > 0;
                    pageCount++;
                    // Chờ 0.5s tránh rate limit
                    await new Promise(r => setTimeout(r, 500));
                } else {
                    hasMore = false;
                }
            }
            
            // Lấy chi tiết từng giao dịch (chỉ lấy 20 gần nhất để tránh quá tải)
            const formatted = [];
            const recentTx = allTransactions.slice(0, 30);
            let counter = 0;
            
            for (let tx of recentTx) {
                if (!tx.trans_id) continue;
                const detailUrl = `https://sapi.zalopay.vn/v2/history/transactions/${tx.trans_id}?type=1`;
                const headers = {
                    'Cookie': this.config.cookie || '',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
                };
                try {
                    const detailResp = await axios.get(detailUrl, { headers });
                    const detail = detailResp.data;
                    if (detail && detail.data && detail.data.transaction) {
                        const trans = detail.data.transaction;
                        let note = '';
                        if (trans.template_info && Array.isArray(trans.template_info.custom_fields)) {
                            const field = trans.template_info.custom_fields.find(f => f.name === 'Lời nhắn');
                            if (field) note = field.value || '';
                        }
                        const type = (trans.sign && trans.sign == 1) ? 'IN' : 'OUT';
                        const date = trans.trans_time ? new Date(trans.trans_time).toLocaleString('vi-VN') : '';
                        formatted.push({
                            transactionID: trans.trans_id || trans.app_trans_id,
                            amount: trans.charge_amount || trans.trans_amount || 0,
                            description: (trans.description || '') + (note ? ' - ' + note : ''),
                            transactionDate: date,
                            type: type,
                            balance: tx.balance_snapshot || 0
                        });
                    }
                    counter++;
                    if (counter % 5 === 0) await new Promise(r => setTimeout(r, 300));
                } catch(e) {
                    console.error('Lỗi lấy chi tiết giao dịch:', e.message);
                }
            }
            
            return {
                status: 'success',
                msg: 'Lấy lịch sử thành công',
                transactions: formatted
            };
        } catch (e) {
            console.error('getTransactions2 error:', e);
            return {
                status: 'error',
                msg: 'Lỗi: ' + e.message,
                transactions: []
            };
        }
    }
    async get_info_web(phone) {
        let p = phone.startsWith('0') ? '84' + phone.substring(1) : phone;
        return await this.getRequest(`https://sapi.zalopay.vn/v3/ibft/web/get-user-info?phone=${p}`, {
            'Referer': 'https://social.zalopay.vn/spa/v2/home-transfer'
        });
    }
    async Order_Money_web(info, msg, amount, cfm_token = '') {
        const data = {
            receiver_zalopay_id: "", receiver_zalo_id: "",
            receiver_name: info.data.name, receiver_avatar: info.data.avatar,
            amount: parseInt(amount), note: msg,
            zalo_token: "", media: { greeting_card: { theme_id: "142" } },
            utoken: "", zpp: decodeURIComponent(info.data.zpp)
        };
        if (cfm_token) data.cfm_token = cfm_token;
        const result = await this.postRequest('https://sapi.zalopay.vn/mt/v5/create-order-v2', data);
        if (!cfm_token && result?.error?.details?.error_info?.reason === 'Reason_DUPLICATE_ORDER') {
            const token = result.error.details.error_info.metadata?.cfm_token;
            if (token) {
                console.log('[Order_Money_web] Duplicate order detected, retrying with cfm_token');
                return await this.Order_Money_web(info, msg, amount, token);
            }
        }
        return result;
    }
    async Get_assets_web(order) {
        const url = 'https://sapi.zalopay.vn/v2/cashier/assets';
        const data = {
            order_type: "FULL_ORDER", full_assets: true,
            order_data: {
                app_id: order.app_id, app_trans_id: order.app_trans_id, app_time: order.app_time,
                app_user: order.app_user, amount: order.amount, item: order.item || "[]",
                description: order.description, embed_data: order.embeddata ? JSON.stringify(order.embeddata) : '"{}"',
                mac: order.mac || "", trans_type: 1, product_code: "TF007",
                service_fee: { fee_amount: 0, total_free_trans: 0, remain_free_trans: 0 }
            },
            token_data: { trans_token: "", app_id: order.app_id, order_token: order.order_token },
            campaign_code: "", display_mode: 1
        };
        return await this.postRequest(url, data, true);
    }
    async Pay_Money_web(assets) {
        const data = {
            authenticator: { authen_type: 1, auth_info: "eyJhdXRoX3R5cGUiOjF9", pin: this.sha256(this.config.password) },
            order_fee: [0], order_token: assets.data.order_token,
            promotion_token: "", service_id: 19,
            sof_token: assets.data.sources_of_fund[0].sof_token,
            user_fee: [0], zalo_token: "",
            callback_url: `zalo://qr/jp/nibvlsoj2j?cb_t=dotp&k=${Date.now()}&otp=`,
            card: null, is_zmp: false
        };
        return await this.postRequest('https://sapi.zalopay.vn/v2/cashier/pay', data, true);
    }
    async SendMoney_web(phone, msg, amount) {
        console.log('[SendMoney_web] Step 1: get_info_web for phone:', phone);
        const info = await this.get_info_web(phone);
        if (!info.data) return { status: 'error', message: info.error?.details?.localized_message?.message || 'SĐT không hợp lệ' };
        console.log('[SendMoney_web] Step 2: Order_Money_web amount:', amount);
        const order = await this.Order_Money_web(info, msg, amount);
        if (!order || (!order.data && !order.ac_order)) return { status: 'error', message: order?.error?.details?.localized_message?.message || 'Lỗi tạo đơn chuyển tiền' };
        const orderData = order.ac_order || order.data || {};
        order.app_id = orderData.app_id;
        order.app_trans_id = orderData.app_trans_id;
        order.order_token = orderData.order_token;
        order.app_time = Date.now();
        order.app_user = "ZaloPay";
        order.amount = amount;
        order.description = msg;
        order.mac = "";
        order.item = "[]";
        const assets = await this.Get_assets_web(order);
        let source_of_fund = null;
        if (assets && assets.data) {
            if (assets.data.source_of_fund) {
                source_of_fund = assets.data.source_of_fund;
            } else if (assets.data.sources_of_fund && assets.data.sources_of_fund.length > 0) {
                source_of_fund = assets.data.sources_of_fund[0];
            }
        }
        if (!source_of_fund || source_of_fund.status !== 1) {
            return { status: 'error', message: source_of_fund?.message || 'Lỗi nguồn tiền/Số dư' };
        }
        if (Number(source_of_fund.balance) < Number(amount)) return { status: 'error', message: 'Số Dư Không Đủ' };
        const pay = await this.Pay_Money_web(assets);
        if (!pay || pay.error) return { status: 'error', message: pay.error?.details?.localized_message?.message || 'Chuyển tiền thất bại' };
        const orderDataRes = order.ac_order || order.data || {};
        if (pay.data && (pay.data.is_processing === 1 || pay.data.is_processing === true)) {
            return {
                status: 'success', message: 'Chuyển Tiền Thành Công',
                data: {
                    zp_trans_id: pay.data.zp_trans_id || orderDataRes.order_no, partner_name: info.data.name,
                    partner_id: info.data.zalopay_id, amount: amount, owner_phone: this.config.phone
                }
            };
        }
        return { status: 'error', message: 'Trạng thái chuyển không xác định' };
    }
    async Create_QR_web(amount, note) {
        return await this.postRequest('https://sapi.zalopay.vn/v1/mt/flex-qrcode/generate', {
            amount: parseInt(amount), message: note, size: 190
        }, true);
    }
    async get_name_bank_web(stk, bankcode) {
        const url = 'https://scard.zalopay.vn/v1/mt/ibft-switch/tof/inquiry';
        const data = { bank_code: bankcode, bank_number: stk, type: 0 };
        const h = this.getZaloHeader(); h['Host'] = 'scard.zalopay.vn'; h['Content-Type'] = 'text/plain;charset=UTF-8';
        try {
            const resp = await axios.post(url, JSON.stringify(data), { headers: h });
            return resp.data;
        } catch(e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async createorder_send_bank_web(stk, config_bank, info_data, amount, description) {
        const url = 'https://scard.zalopay.vn/v1/mt/ibft-switch/tof/create-order';
        const data = {
            amount: parseInt(amount), bank_code: config_bank.bankcode,
            bank_holder_name: info_data.bank_holder_name, bank_number: stk,
            ii_type: 0, inquiry_info: info_data.inquiry_info, message: description,
            nickname: info_data.nickname, save: info_data.saved || false, type: info_data.type || 0
        };
        const h = this.getZaloHeader(); h['Host'] = 'scard.zalopay.vn'; h['Content-Type'] = 'text/plain;charset=UTF-8';
        try {
            const resp = await axios.post(url, JSON.stringify(data), { headers: h });
            return resp.data;
        } catch(e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async assets_bank_web(order) {
        const url = 'https://sapi.zalopay.vn/v2/cashier/assets';
        const data = {
            order_type: "FULL_ORDER", full_assets: true,
            order_data: {
                app_id: order.app_id, app_trans_id: order.app_trans_id, app_time: order.app_time,
                app_user: order.app_user, amount: order.amount, item: JSON.stringify(order.item),
                description: order.description, embed_data: order.embeddata ? JSON.stringify(order.embeddata) : '"{}"',
                mac: order.mac, trans_type: 1, product_code: "TF007",
                service_fee: { fee_amount: 0, total_free_trans: 0, remain_free_trans: 0 }
            },
            token_data: { trans_token: "", app_id: order.app_id, order_token: order.order_token },
            campaign_code: "", display_mode: 1
        };
        return await this.postRequest(url, data, true);
    }
    async pay_bank_web(assets) {
        const data = {
            authenticator: { authen_type: 1, auth_info: "eyJhdXRoX3R5cGUiOjF9", pin: this.sha256(this.config.password) },
            order_fee: [0], order_token: assets.data.order_token, promotion_token: "", service_id: 19,
            sof_token: assets.data.sources_of_fund[0].sof_token, user_fee: [0], zalo_token: "",
            callback_url: `zalo://qr/jp/nibvlsoj2j?cb_t=dotp&k=${Date.now()}&otp=`, card: null, is_zmp: false
        };
        return await this.postRequest('https://sapi.zalopay.vn/v2/cashier/pay', data, true);
    }
    async SendMoney_Bank_web(stk, amount, description, config_bank) {
        const info = await this.get_name_bank_web(stk, config_bank.bankcode);
        if (!info || !info.bank_holder_name) return { status: 'error', message: 'STK rỗng hoặc không đúng' };
        const order = await this.createorder_send_bank_web(stk, config_bank, info, amount, description);
        if (!order || !order.ac_order) return { status: 'error', message: order?.error?.details?.localized_message?.message || 'Tạo lệnh thất bại' };
        let numberBank4 = stk.slice(-4);
        let first6 = stk.substring(0, 6);
        order.app_id = order.ac_order.app_id;
        order.app_trans_id = order.ac_order.app_trans_id;
        order.order_token = order.ac_order.order_token;
        order.app_time = Date.now();
        order.app_user = "ZaloPay";
        order.amount = amount;
        order.description = description;
        order.mac = "";
        order.item = `{"ibfttype":2,"ibfttranstype":1,"ext":"Người nhận:${info.bank_holder_name}\\tNgân hàng:${config_bank.bankcode}\\tSố tài khoản:**** ${numberBank4}","number":"","bcbankcode":"${config_bank.bcbankcode}","bimid":"","bimtoken":"","first6no":"${first6}","last4no":"${numberBank4}"}`;
        const assets = await this.assets_bank_web(order);
        let source_of_fund = null;
        if (assets && assets.data) {
            if (assets.data.source_of_fund) {
                source_of_fund = assets.data.source_of_fund;
            } else if (assets.data.sources_of_fund && assets.data.sources_of_fund.length > 0) {
                source_of_fund = assets.data.sources_of_fund[0];
            }
        }
        if (!source_of_fund || Number(source_of_fund.balance) < Number(amount)) {
            return { status: 'error', message: assets?.error?.details?.localized_message?.message || source_of_fund?.message || 'Lỗi tiền dư hoặc không tìm thấy nguồn tiền' };
        }
        const pay = await this.pay_bank_web(assets);
        if (pay && pay.data && pay.data.is_processing) {
            return { status: 'success', message: 'Chuyển bank thành công', data: { zp_trans_id: pay.data.zp_trans_id } };
        }
        return { status: 'error', message: pay?.error?.details?.localized_message?.message || 'Lỗi chuyển tiền' };
    }
}

// ========================== DB MODULE ==========================
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

// ========================== EXPRESS APP ==========================
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = 8000;

app.get('/api/accounts', async (req, res) => {
    try {
        const accounts = await getAccounts();
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
                const token_api = crypto.createHash('md5').update(randomString(6) + Date.now()).digest('hex');
                let account = await getAccountByPhone(phone);
                if (account) {
                    account.type_api = 'web';
                    account.cookie = cookie;
                    account.status = 'pending';
                } else {
                    account = {
                        phone, type_api: 'web', cookie, status: 'pending', userID: 1, token_api, id: Date.now().toString()
                    };
                }
                await saveAccount(account);
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
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: 'Đăng nhập thành công' });
                } else {
                    account.status = 'error';
                    account.errorDesc = 'Cookie Không Hợp Lệ';
                    await saveAccount(account);
                    return res.json({ status: 'error', msg: 'Cookie Không Hợp Lệ hoặc Lỗi login' });
                }
            }
            case 'RELOADBALANCE': {
                const { id } = req.body;
                const account = await getAccountById(id);
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
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: `Cập nhật số dư thành công: ${account.balance}đ` });
                } else {
                    account.status = 'out';
                    account.errorDesc = 'Cookie Die';
                    await saveAccount(account);
                    return res.json({ status: 'error', msg: 'Lỗi lấy số dư (Cookie có thể đã chết)' });
                }
            }
            case 'history': {
                const { phone } = req.body;
                const account = await getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Không tìm thấy tài khoản', transactions: [] });
                z.loadData(account);
                const history = await z.getTransactions2();
                return res.json(history);
            }
            case 'update': {
                const { phone, cookie } = req.body;
                if (!phone || !cookie) return res.json({ status: 'error', msg: 'Thiếu thông tin' });
                const account = await getAccountByPhone(phone);
                if (account) {
                    account.cookie = cookie;
                    account.time_login = Math.floor(Date.now() / 1000);
                    account.status = 'pending';
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: 'Cập nhật cookie thành công' });
                }
                return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
            }
            case 'REMOVE': {
                const { id } = req.body;
                await removeAccount(id);
                return res.json({ status: 'success', msg: 'Đã xóa tài khoản' });
            }
            case 'transfer': {
                const { receiver, account: phone, amount, comment, password } = req.body;
                if (!receiver || !phone || !amount || !password) return res.json({ status: 'error', msg: 'Nhập thiếu thông tin chuyển tiền' });
                const account = await getAccountByPhone(phone);
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
                        await saveAccount(account);
                    }
                    await logTransaction({
                        type_gd: 'sendmoney', tranId: send.data.zp_trans_id,
                        partnerId: receiver, amount, comment, status: 'success',
                        message: 'Chuyển Tiền Thành Công', user_id: 1
                    });
                    return res.json({ status: 'success', msg: `Chuyển thành công. Số dư: ${account.balance || 0}` });
                }
            }
            case 'CreateQR': {
                const { id, amount } = req.body;
                const account = await getAccountById(id);
                if (!account) return res.json({ status: 'error', msg: 'Acc không tồn tại' });
                z.loadData(account);
                const qr = await z.Create_QR_web(amount, '');
                return res.json({ status: 'success', msg: 'OK', data: qr });
            }
            case 'NameBank': {
                const { phone, stk, bank } = req.body; 
                const account = await getAccountByPhone(phone);
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
                const account = await getAccountByPhone(phone);
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
                        await saveAccount(account);
                    }
                    await logTransaction({
                        type_gd: 'sendbank', tranId: send.data.zp_trans_id,
                        partnerId: stk, partnerName: name, amount, comment, status: 'success',
                        user_id: 1
                    });
                    return res.json({ status: 'success', msg: `Chuyển Bank thành công. Số dư: ${account.balance || 0}` });
                }
            }
            case 'ANTI': {
                const { phone, status, ip } = req.body;
                const account = await getAccountByPhone(phone);
                if (account) {
                    account.ip_white = ip;
                    account.status_ip_white = status;
                    await saveAccount(account);
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

// ========================== NHÚNG TOÀN BỘ HTML (ĐÃ SỬA HIỂN THỊ SỐ DƯ VÀ LỊCH SỬ) ==========================
const htmlContent = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Quản Lý ZaloPay Cá Nhân</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        body { background-color: #f0f2f5; font-family: 'Inter', sans-serif; }
        .card-zalo { border: none; border-radius: 15px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); margin-bottom: 20px; transition: transform 0.2s; }
        .card-zalo:hover { transform: translateY(-5px); }
        .zalo-header { background: #0068ff; color: white; border-radius: 15px 15px 0 0; padding: 15px; }
        .avatar-zalo { width: 60px; height: 60px; border-radius: 50%; border: 2px solid white; object-fit: cover; }
        .balance-text { font-size: 1.2rem; font-weight: bold; color: #28a745; }
        .loader { border: 4px solid #f3f3f3; border-radius: 50%; border-top: 4px solid #0068ff; width: 30px; height: 30px; animation: spin 1s linear infinite; display: inline-block; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .table-small td, .table-small th { font-size: 0.85rem; }
    </style>
</head>
<body>

<div class="container py-5">
    <h3 class="text-center mb-4 text-primary fw-bold"><i class="fa-solid fa-wallet"></i> NODE.JS API BANK: ZALOPAY</h3>

    <div class="row justify-content-center mb-5">
        <div class="col-md-8">
            <div class="card card-zalo">
                <div class="card-body">
                    <h5 class="card-title text-center mb-3">Thêm Tài Khoản Mới</h5>
                    <form id="loginForm">
                        <input type="hidden" name="action" value="LOGIN">
                        <div class="row g-2">
                            <div class="col-md-4">
                                <input type="text" class="form-control" name="phone" placeholder="Số điện thoại" required>
                            </div>
                            <div class="col-md-4">
                                <input type="text" class="form-control" name="password" placeholder="Mật khẩu ví" required>
                            </div>
                            <div class="col-md-12">
                                <textarea class="form-control" name="cookie" rows="2" placeholder="Dán Cookie vào đây (zpw_sek=...)" required></textarea>
                            </div>
                        </div>
                        <button type="submit" class="btn btn-primary w-100 mt-3"><i class="fa-solid fa-plus"></i> Thêm / Cập nhật</button>
                    </form>
                </div>
            </div>
        </div>
    </div>

    <div class="row" id="accountsList">
        <div class="col-12 text-center text-muted py-5"><div class="loader"></div><br><small>Đang tải tài khoản...</small></div>
    </div>
</div>

<!-- Modal chuyển tiền ZaloPay -->
<div class="modal fade" id="modalTransfer" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Chuyển Tiền ZaloPay</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <form id="formTransfer">
                    <input type="hidden" name="action" value="transfer">
                    <input type="hidden" name="account" id="tf_account">
                    <input type="hidden" name="password" id="tf_password">
                    <div class="mb-3"><label>Người nhận (SĐT)</label><input type="text" name="receiver" class="form-control" required></div>
                    <div class="mb-3"><label>Số tiền</label><input type="number" name="amount" class="form-control" required></div>
                    <div class="mb-3"><label>Lời nhắn</label><input type="text" name="comment" class="form-control" value="Chuyen tien"></div>
                    <button type="submit" class="btn btn-primary w-100">Gửi Tiền</button>
                </form>
            </div>
        </div>
    </div>
</div>

<!-- Modal chuyển tiền ngân hàng -->
<div class="modal fade" id="modalBank" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Chuyển Tiền Ngân Hàng</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <form id="formBank">
                    <input type="hidden" name="action" value="transfer_bank">
                    <input type="hidden" name="account" id="bk_account">
                    <input type="hidden" name="password" id="bk_password">
                    <input type="hidden" name="name" id="bk_name_hidden"> 
                    <div class="mb-3">
                        <label>Chọn Ngân Hàng</label>
                        <select name="bank" id="bk_bank_select" class="form-select">
                            <option value="">Đang tải danh sách ngân hàng...</option>
                        </select>
                    </div>
                    <div class="mb-3">
                        <label>Số Tài Khoản</label>
                        <div class="input-group">
                            <input type="text" name="stk" id="bk_stk" class="form-control" required>
                            <button class="btn btn-outline-secondary" type="button" onclick="checkNameBank()">Check Tên</button>
                        </div>
                    </div>
                    <div class="mb-3">
                        <label>Tên Người Nhận</label>
                        <input type="text" id="bk_name_display" class="form-control" readonly style="background-color: #e9ecef;">
                    </div>
                    <div class="mb-3">
                        <label>Số tiền</label>
                        <input type="number" name="amount" class="form-control" required>
                    </div>
                    <div class="mb-3">
                        <label>Lời nhắn</label>
                        <input type="text" name="comment" class="form-control" value="Chuyen khoan">
                    </div>
                    <button type="submit" class="btn btn-warning w-100">Chuyển Khoản</button>
                </form>
            </div>
        </div>
    </div>
</div>

<!-- Modal lịch sử giao dịch -->
<div class="modal fade" id="modalHistory" tabindex="-1">
    <div class="modal-dialog modal-xl">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title">Lịch Sử Giao Dịch (30 gần nhất)</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
                <div class="table-responsive">
                    <table class="table table-bordered table-striped table-small">
                        <thead class="table-dark">
                            <tr>
                                <th>Mã GD</th>
                                <th>Thời gian</th>
                                <th>Số tiền</th>
                                <th>Loại</th>
                                <th>Nội dung</th>
                                <th>Số dư sau GD</th>
                            </tr>
                        </thead>
                        <tbody id="historyBody"></tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>

<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>

<script>
    const API_URL = '/api.php';
    const API_ACCOUNTS = '/api/accounts';
    
    function formatMoney(amount) {
        if (amount === undefined || amount === null) return '0₫';
        return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
    }
    
    function loadAccounts() {
        $.getJSON(API_ACCOUNTS, function(res) {
            if (res.status === 'success') {
                const arr = res.data;
                const container = $('#accountsList');
                container.empty();
                if (arr.length === 0) {
                    container.html('<div class="col-12 text-center text-muted py-5">Chưa có tài khoản nào. Hãy thêm ngay!</div>');
                    return;
                }
                arr.forEach(row => {
                    const statusBadge = row.status === 'success' 
                                        ? '<span class="badge bg-success">Live</span>' 
                                        : '<span class="badge bg-danger">Die</span>';
                    const avatar = row.avatar || 'https://via.placeholder.com/60';
                    const name = row.name || 'Chưa có tên';
                    const timeUpdate = row.time_login ? new Date(row.time_login * 1000).toLocaleString() : 'Chưa đăng nhập';
                    const balance = row.balance || 0;
                    container.append(\`
                        <div class="col-md-6 col-lg-4">
                            <div class="card card-zalo">
                                <div class="zalo-header d-flex align-items-center justify-content-between">
                                    <div class="d-flex align-items-center">
                                        <img src="\${avatar}" class="avatar-zalo me-2">
                                        <div><h6 class="m-0">\${name}</h6><small>\${row.phone}</small></div>
                                    </div>
                                    \${statusBadge}
                                </div>
                                <div class="card-body">
                                    <p class="mb-1">Số dư: <span class="balance-text">\${formatMoney(balance)}</span></p>
                                    <p class="mb-1 text-muted small">Cập nhật: \${timeUpdate}</p>
                                    <hr>
                                    <div class="d-grid gap-2">
                                        <button onclick="reloadBalance('\${row.id}')" class="btn btn-outline-primary btn-sm"><i class="fa-solid fa-rotate"></i> Cập nhật số dư</button>
                                        <div class="btn-group">
                                            <button onclick="openModalTransfer('\${row.phone}', '\${row.password}')" class="btn btn-success btn-sm"><i class="fa-solid fa-paper-plane"></i> Chuyển Zalo</button>
                                            <button onclick="openModalBank('\${row.phone}', '\${row.password}')" class="btn btn-warning btn-sm"><i class="fa-solid fa-building-columns"></i> Chuyển Bank</button>
                                        </div>
                                        <button onclick="viewHistory('\${row.phone}')" class="btn btn-info btn-sm text-white"><i class="fa-solid fa-clock-rotate-left"></i> Lịch sử GD</button>
                                        <button onclick="removeAcc('\${row.id}')" class="btn btn-danger btn-sm"><i class="fa-solid fa-trash"></i> Xóa</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    \`);
                });
            } else {
                Swal.fire('Lỗi', 'Không thể tải danh sách tài khoản', 'error');
            }
        });
    }
    
    $(document).ready(function() { 
        loadAccounts(); 
        $.getJSON('https://api.vietqr.io/v2/banks', function(res) {
            if (res.code === "00" && res.data) {
                let options = '';
                res.data.forEach(function(bank) {
                    if (bank.transferSupported === 1) {
                        let val = bank.bin + '-' + bank.code + '-' + bank.shortName + '-' + bank.name;
                        options += '<option value="' + val + '">' + bank.shortName + ' (' + bank.name + ')</option>';
                    }
                });
                $('#bk_bank_select').html(options);
            } else {
                $('#bk_bank_select').html('<option value="">Lỗi tải danh sách NH</option>');
            }
        });
    });
    
    $('#loginForm').submit(function(e){
        e.preventDefault();
        Swal.fire({title: 'Đang xử lý...', didOpen: () => { Swal.showLoading() }});
        $.post(API_URL, $(this).serialize(), function(res){
            if(res.status == 'success'){
                Swal.fire('Thành công', res.msg, 'success').then(() => loadAccounts());
            } else {
                Swal.fire('Lỗi', res.msg, 'error');
            }
        });
    });
    
    function reloadBalance(id){
        Swal.fire({title: 'Đang cập nhật...', didOpen: () => { Swal.showLoading() }});
        $.post(API_URL, {action: 'RELOADBALANCE', id: id}, function(res){
            if(res.status == 'success'){
                Swal.fire('Xong', res.msg, 'success').then(() => loadAccounts());
            } else { Swal.fire('Lỗi', res.msg, 'error'); }
        });
    }
    
    function viewHistory(phone){
        $('#modalHistory').modal('show');
        $('#historyBody').html('<tr><td colspan="6" class="text-center">Đang tải lịch sử giao dịch...<div class="loader mt-2"></div></td></tr>');
        $.post(API_URL, {action: 'history', phone: phone}, function(res){
            if(res.status == 'success' && res.transactions && res.transactions.length > 0){
                let html = '';
                res.transactions.forEach(item => {
                    let moneyClass = item.type === 'IN' ? 'text-success' : 'text-danger';
                    let sign = item.type === 'IN' ? '+' : '-';
                    let typeText = item.type === 'IN' ? 'Nhận tiền' : 'Chuyển tiền';
                    html += \`
                        <tr>
                            <td><small>\${item.transactionID}</small></td>
                            <td><small>\${item.transactionDate || 'Không rõ'}</small></td>
                            <td class="\${moneyClass} fw-bold">\${sign} \${formatMoney(item.amount)}</td>
                            <td><span class="badge bg-\${item.type === 'IN' ? 'success' : 'danger'}">\${typeText}</span></td>
                            <td><small>\${item.description || 'Không có nội dung'}</small></td>
                            <td>\${formatMoney(item.balance || 0)}</td>
                        </tr>
                    \`;
                });
                $('#historyBody').html(html);
            } else {
                $('#historyBody').html('<tr><td colspan="6" class="text-center text-danger">' + (res.msg || 'Không có giao dịch hoặc lỗi cookie') + '</td></tr>');
            }
        }).fail(function() {
            $('#historyBody').html('<tr><td colspan="6" class="text-center text-danger">Lỗi kết nối server</td></tr>');
        });
    }
    
    function openModalTransfer(phone, pass){
        $('#tf_account').val(phone); $('#tf_password').val(pass);
        $('#modalTransfer').modal('show');
    }
    
    $('#formTransfer').submit(function(e){
        e.preventDefault();
        Swal.fire({
            title: 'Xác nhận chuyển',
            text: 'Chắc chắn muốn chuyển tiền?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Có, chuyển!',
            cancelButtonText: 'Hủy'
        }).then((result) => {
            if (result.isConfirmed) {
                Swal.fire({title: 'Đang chuyển...', didOpen: () => { Swal.showLoading() }});
                $.post(API_URL, $('#formTransfer').serialize(), function(res){
                    if(res.status == 'success'){
                        $('#modalTransfer').modal('hide');
                        Swal.fire('Thành công', res.msg, 'success').then(() => loadAccounts());
                    } else {
                        Swal.fire('Thất bại', res.msg, 'error');
                    }
                });
            }
        });
    });
    
    function openModalBank(phone, pass){
        $('#bk_account').val(phone); $('#bk_password').val(pass);
        $('#modalBank').modal('show');
        $('#bk_name_display').val(''); $('#bk_name_hidden').val(''); $('#bk_stk').val('');
    }
    
    function checkNameBank(){
        let phone = $('#bk_account').val();
        let stk = $('#bk_stk').val();
        let bank = $('#bk_bank_select').val();
        if(!stk) {
            Swal.fire('Lỗi', 'Nhập số tài khoản trước', 'error');
            return;
        }
        $('#bk_name_display').val('Đang kiểm tra...');
        $.post(API_URL, {action: 'NameBank', phone: phone, stk: stk, bank: bank}, function(res){
            if(res.status == 'success'){
                $('#bk_name_display').val(res.msg); $('#bk_name_hidden').val(res.msg);
                Swal.fire({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, icon: 'success', title: 'Đã check tên!' });
            } else {
                $('#bk_name_display').val('Không tìm thấy tên');
                Swal.fire('Lỗi', res.msg, 'error');
            }
        });
    }
    
    $('#formBank').submit(function(e){
        e.preventDefault();
        if($('#bk_name_hidden').val() == '') {
            Swal.fire('Chú ý', 'Vui lòng Check Tên trước khi chuyển!', 'warning');
            return;
        }
        Swal.fire({
            title: 'Xác nhận chuyển tiền',
            text: 'Chắc chắn chuyển cho: ' + $('#bk_name_hidden').val() + '?',
            icon: 'info',
            showCancelButton: true,
            confirmButtonText: 'Chuyển Khoản!',
            cancelButtonText: 'Hủy'
        }).then((result) => {
            if (result.isConfirmed) {
                Swal.fire({title: 'Đang xử lý...', text: 'Vui lòng chờ...', didOpen: () => { Swal.showLoading() }});
                $.post(API_URL, $('#formBank').serialize(), function(res){
                    if(res.status == 'success'){
                        $('#modalBank').modal('hide');
                        Swal.fire('Thành công', res.msg, 'success').then(() => loadAccounts());
                    } else {
                        Swal.fire('Thất bại', res.msg, 'error');
                    }
                });
            }
        });
    });
    
    function removeAcc(id){
        Swal.fire({
            title: 'Xóa tài khoản?',
            text: 'Bạn có chắc chắn muốn xóa tài khoản này khỏi tool?',
            icon: 'warning',
            showCancelButton: true,
            confirmButtonText: 'Xóa',
            cancelButtonText: 'Hủy'
        }).then((result) => {
            if (result.isConfirmed) {
                $.post(API_URL, {action: 'REMOVE', id: id}, function(res){
                    Swal.fire('Đã xóa', '', 'success').then(() => loadAccounts());
                });
            }
        });
    }
</script>
</body>
</html>`;

app.get('/', (req, res) => {
    res.send(htmlContent);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`ZaloPay API chạy tại http://0.0.0.0:${PORT}`);
});