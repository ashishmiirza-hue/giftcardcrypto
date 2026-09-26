# Tohfa: Crypto se gift card store

Customer **USDT (BEP-20, BNB Smart Chain)** se gift card khareedta hai: wallet connect karke (Reown/WalletConnect), ya exchange/Trust Wallet se seedha address par bhej ke. Verification tumhara apna server blockchain se karta hai. Payment confirm hote hi code screen par aa jata hai.

Network `NETWORK` setting se badalta hai: `bsc` (USDT, default), `base` (USDC), `base-sepolia` (free test USDC).

```
giftcardcrypto/          <- GitHub repo ka top level yahi hona chahiye
├── store/               Customer website
├── admin/               Admin panel
├── backend/             API + payment verification
├── render.yaml          Render setup
├── .node-version        Node 22 (Render isse padhta hai)
└── README.md
```

Repo ke top level par in ke alawa aur kuch nahi hona chahiye. Pehle galti se upload hui files (`server.js`, `main.js`, `index.html`, zip waghera) delete kar do.

---

## Render par deploy (ek service, BSC USDT)

Ek hi Render service store, admin aur backend teeno chalati hai:
- Store: `https://<service>.onrender.com/`
- Admin: `https://<service>.onrender.com/admin/`
- Status: `https://<service>.onrender.com/api/health`

**Settings** (agar Blueprint ki jagah manually banayi hai):

| Setting | Value |
|---|---|
| Language | Node |
| Root Directory | *(khaali)* |
| Build Command | `cd store && npm install && npm run build && cd ../admin && npm install && npm run build && cd ../backend && rm -rf node_modules && npm install` |
| Start Command | `cd backend && npm start` |
| Health Check Path | `/api/health` |

**Environment variables:**

| Key | Value |
|---|---|
| `NODE_VERSION` | `22` |
| `NETWORK` | `bsc` |
| `RECEIVING_WALLET` | tumhara wallet address (`0x...`), private key nahi |
| `REOWN_PROJECT_ID` | Optional. Khaali = bina Reown ke (wallet ke browser / MetaMask extension se connect) |
| `ADMIN_KEY` | 16+ characters ka password |
| `RPC_URL` | khaali chhodo (free public RPC), ya Ankr: `https://rpc.ankr.com/bsc/KEY` |
| `INR_RATE_FALLBACK` | `96` |

Save ke baad **Manual Deploy → Clear build cache & deploy**.

**Deploy sahi hua ya nahi:** `/api/health` kholo. `"blockchain":"connected"` dikhe to sab theek hai. `"not connected"` ho to `problem` mein wajah likhi hogi. Site phir bhi khuli rahegi, aur admin panel ke upar laal warning dikhegi.

**Wallet connect:** Reown zaroori nahi. Phone par customer ko "Open in Trust Wallet / MetaMask" buttons milte hain (site wallet ke andar khulti hai), PC par MetaMask extension se connect hota hai. Reown ka QR chahiye to `REOWN_PROJECT_ID` daalo aur domain Reown allow-list mein add karo.

---

## Pehla asli test (1 USDT)

1. `/admin/` kholo aur login karo.
2. **New card** banao: Face value ₹100, Discount 0. Price lagbhag 1 USDT aayegi.
3. Us card mein ek code daalo, jaise `TEST-001`. Sample cards ka **Shown** off kar do.
4. Doosre wallet (Trust/MetaMask) mein **BNB Smart Chain** par 2-3 USDT aur thoda **BNB** (gas, ₹20-50 ka kaafi) rakho.
5. Store par ₹100 wala card khareedo. 5-15 second mein code screen par aana chahiye.

Exchange se test: checkout mein "Paying from an exchange" kholo, address aur exact amount copy karo, aur exchange se **USDT, network BEP-20 (BSC)** withdraw karo. Exchange fee amount se kaat de to order match nahi hoga, isliye fee upar se jodna.

---

## Local par chalana (optional)

```bash
cd backend && cp .env.example .env    # .env bharo
npm install && npm start              # http://localhost:3001
# doosre terminal:
cd store && npm install && npm run dev    # http://localhost:3000
# teesre terminal:
cd admin && npm install && npm run dev    # http://localhost:3002
```

Ya `store` aur `admin` mein `npm run build` karke sirf backend chalao. Tab sab `localhost:3001` par milega (`/admin/` bhi). Reown allow-list mein `localhost` daalna.

Testnet par free test karna ho: `NETWORK=base-sepolia`, test USDC faucet.circle.com se.

---

## Payment kaise verify hoti hai
1. Card reserve karne par server ek **unique amount** deta hai, jaise `1.0537 USDT`. Last digits se order pehchana jata hai.
2. Customer pay karta hai, browser txHash server ko bhejta hai.
3. Server blockchain se check karta hai: transaction successful hai, asli USDT contract hai (fake "USDT" token nahi chalega), paisa tumhare wallet mein aaya, amount exact hai, aur txHash pehle use nahi hua. Browser ki kisi baat par bharosa nahi kiya jata.
4. **Backup listener** har 10 second tumhare wallet mein aaye USDT padhta hai. Tab band ho jaye ya exchange se payment aaye, tab bhi order confirm hota hai.
5. Jo payment kisi order se match nahi hoti, wo admin panel mein **"Payments with no matching order"** mein dikhti hai.

## AI token billing (approve + limits + admin se charge)

Site par `/ai.html` page hai jahan customer wallet se USDT approve karke apni limits set karta hai. Tum admin panel ke **AI token billing** section se usage record karke **Charge** dabate ho. Contract deploy karne aur test karne ke poore steps: **`contracts/README.md`**.

## Free plan ki limitation
Render free par 15 minute baad service so jaati hai, aur restart/sleep par **database reset** hota hai (orders, codes mit jaate hain). Test ke liye theek hai. Asli customers se pehle **Starter plan + disk** lo (`render.yaml` mein disk wala hissa uncomment karo, `DB_PATH=/var/data/store.db`).

## Dhyan rakhne wali baatein
- **Private key kabhi server par mat daalna.** Sirf wallet address.
- **Codes** sirf brand ya authorised distributor se lo. Anjaan source ke discount codes stolen ho sakte hain.
- **Tax/legal:** India mein crypto income par alag rules hain (30% tax, 1% TDS, kuch cases mein FIU registration). CA se baat karo.
- **Refunds:** crypto payment reverse nahi hoti. Galat amount wali payments manually wapas bhejni padengi.
