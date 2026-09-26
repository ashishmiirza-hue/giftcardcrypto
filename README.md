# Tohfa: Crypto se gift card store

Customer USDC (Base network) se gift card khareedta hai. Payment **Reown/WalletConnect** se hoti hai, aur verification tumhara apna server blockchain se karta hai (Ankr ya Base ka free public RPC). Payment confirm hote hi code screen par aa jata hai.

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

## Render par deploy (ek service, mainnet)

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
| `NETWORK` | `base` |
| `RECEIVING_WALLET` | tumhara wallet address (`0x...`), private key nahi |
| `REOWN_PROJECT_ID` | Reown dashboard ka Project ID |
| `ADMIN_KEY` | 16+ characters ka password |
| `RPC_URL` | khaali chhodo (free public RPC), ya Ankr: `https://rpc.ankr.com/base/KEY` |
| `USDC_INR_FALLBACK` | `100` |

Save ke baad **Manual Deploy → Clear build cache & deploy**.

**Deploy sahi hua ya nahi:** `/api/health` kholo. `"blockchain":"connected"` dikhe to sab theek hai. `"not connected"` ho to `problem` mein wajah likhi hogi. Site phir bhi khuli rahegi, aur admin panel ke upar laal warning dikhegi.

**Reown:** dashboard.reown.com mein apne project ki allow-list mein `<service>.onrender.com` daalo, warna wallet connect nahi hoga.

---

## Pehla asli test (1 USDC)

1. `/admin/` kholo aur login karo.
2. **New card** banao: Face value ₹100, Discount 0. Price lagbhag 1 USDC aayegi.
3. Us card mein ek code daalo, jaise `TEST-001`. Sample cards ka **Shown** off kar do.
4. Doosre wallet mein **Base network** par 2-3 USDC aur thoda ETH (gas) rakho.
5. Store par ₹100 wala card khareedo. 5-15 second mein code screen par aana chahiye.

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
1. Card reserve karne par server ek **unique amount** deta hai, jaise `1.0537 USDC`. Last digits se order pehchana jata hai.
2. Customer pay karta hai, browser txHash server ko bhejta hai.
3. Server blockchain se check karta hai: transaction successful hai, asli USDC contract hai, paisa tumhare wallet mein aaya, amount exact hai, aur txHash pehle use nahi hua. Browser ki kisi baat par bharosa nahi kiya jata.
4. **Backup listener** har 10 second tumhare wallet mein aaye USDC padhta hai. Tab band ho jaye ya exchange se payment aaye, tab bhi order confirm hota hai.
5. Jo payment kisi order se match nahi hoti, wo admin panel mein **"Payments with no matching order"** mein dikhti hai.

## Free plan ki limitation
Render free par 15 minute baad service so jaati hai, aur restart/sleep par **database reset** hota hai (orders, codes mit jaate hain). Test ke liye theek hai. Asli customers se pehle **Starter plan + disk** lo (`render.yaml` mein disk wala hissa uncomment karo, `DB_PATH=/var/data/store.db`).

## Dhyan rakhne wali baatein
- **Private key kabhi server par mat daalna.** Sirf wallet address.
- **Codes** sirf brand ya authorised distributor se lo. Anjaan source ke discount codes stolen ho sakte hain.
- **Tax/legal:** India mein crypto income par alag rules hain (30% tax, 1% TDS, kuch cases mein FIU registration). CA se baat karo.
- **Refunds:** crypto payment reverse nahi hoti. Galat amount wali payments manually wapas bhejni padengi.
