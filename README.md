# Tohfa: Crypto se gift card store

Customer **USDT (BEP-20, BNB Smart Chain)** se gift card khareedta hai: wallet connect karke (Reown/WalletConnect), ya exchange/Trust Wallet se seedha address par bhej ke. Verification tumhara apna server blockchain se karta hai. Payment confirm hote hi code screen par aa jata hai.

## Multiple networks (BSC, TRON, Arbitrum, Polygon, Base, Ethereum)

Checkout mein customer **"Pay with"** se coin aur network chunta hai: USDT ya USDC, BSC / TRON / Arbitrum / Polygon / Base / Ethereum par.

| Setting | Kya daalna hai |
|---|---|
| `NETWORK` | Main network (AI billing isi par), jaise `bsc` |
| `ENABLED_NETWORKS` | Sirf shuruaat ka default. Asli on/off **admin panel → Payment networks** se hota hai |
| `RECEIVING_WALLET` | Tumhara EVM wallet `0x...`. Saare EVM networks ka paisa isi address par aata hai |
| `TRON_RECEIVING_WALLET` | TRON wallet `T...` (Trust Wallet ke TRON account ya TronLink se) |
| `TRONGRID_API_KEY` | trongrid.io se free key (recommended) |
| `RPC_URL_ARBITRUM`, `RPC_URL_POLYGON`, `RPC_URL_BASE`, `RPC_URL_ETHEREUM` | Har network ka apna RPC (Ankr). Khaali = free public RPC |
| `ENABLED_TOKENS` | Sirf USDT chahiye to `USDT` (khaali = USDT aur USDC dono) |

- EVM networks par customer wallet se pay karta hai (MetaMask/Trust), network apne aap switch hota hai. Exchange se bhi bhej sakta hai.
- TRON par customer address + exact amount (QR ke saath) par bhejta hai. Server TronGrid se 1-2 minute mein khud pakad leta hai.
- Har order ka amount us network + coin par unique hota hai, isliye payments aapas mein mix nahi hoti.
- **Admin panel → Payment networks:** har network ka on/off switch, har coin (USDT/USDC) ka alag checkbox, status aur RPC info. **Save changes** dabate hi checkout badal jata hai, Render chhune ki zaroorat nahi. Setting database mein save rehti hai.
- Band kiye network par naye orders nahi bante, lekin jin customers ka order pehle se khula hai unka payment server tab tak pakadta rehta hai jab tak wo order band na ho jaye. Uske baad us network ki blockchain checking ruk jaati hai (RPC credits bachte hain).
- TRON switch tab tak band rehta hai jab tak Render mein `TRON_RECEIVING_WALLET` na ho. Card par ye likha aata hai.
- Kam se kam ek payment option hamesha on rehna chahiye. AI billing hamesha main network par chalti hai, in switches se uspar asar nahi padta.
- Ethereum par fees zyada hai; chaho to `ENABLED_NETWORKS` se hata do.

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
