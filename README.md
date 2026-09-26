# Tohfa: Crypto se gift card store

Teen alag hisse hain:

```
tohfa/
├── store/        Customer website  -> Netlify site #1
├── admin/        Admin panel       -> Netlify site #2
├── backend/      API + payment verification (Ankr) -> Render
└── render.yaml   Render ka ready-made setup
```

Store aur admin sirf HTML/JS hain, isliye Netlify par chal jate hain. **Backend Netlify par nahi chalega**, kyunki:
- Netlify Functions har request ke baad band ho jaate hain. Hamara listener har 10 second blockchain check karta hai, uske liye server hamesha chalu rehna chahiye.
- Netlify par database file (SQLite) save nahi rehti.

Isliye backend **Render** par (ya kisi VPS par).

**Sabse aasaan (testing ke liye):** sab kuch ek hi Render service par. Neeche section 2 dekho. Netlify wala tareeka section 3 mein hai.

---

## 1. Local test (abhi ke liye yahi karo)

Teen terminal chahiye. Node.js 20+ hona chahiye.

**Terminal 1: backend**
```bash
cd backend
cp .env.example .env     # .env kholo aur bharo (neeche dekho)
npm install
npm start                # http://localhost:3001
```

`.env` mein kam se kam ye bharo:
```
NETWORK=base-sepolia
RPC_URL=https://rpc.ankr.com/base_sepolia/YOUR_ANKR_KEY
RECEIVING_WALLET=0xTumharaWalletAddress
REOWN_PROJECT_ID=tumhara_reown_project_id
ADMIN_KEY=koi-lamba-random-password-16-se-zyada
```

**Terminal 2: store**
```bash
cd store
npm install
npm run dev              # http://localhost:3000
```

**Terminal 3: admin**
```bash
cd admin
npm install
npm run dev              # http://localhost:3002
```

Store aur admin ka `/api` apne aap `localhost:3001` (backend) par chala jata hai, kuch set nahi karna.

**Reown dashboard** (dashboard.reown.com) mein apne project ke allowed domains mein `localhost` daal do, warna wallet connect nahi hoga.

### Test payment (free test paisa)
1. Wallet (MetaMask) mein **Base Sepolia** network add karo.
2. Gas ke liye test ETH kisi "Base Sepolia faucet" se lo. Test USDC **faucet.circle.com** se lo (network: Base Sepolia).
3. Admin (`localhost:3002`) mein login karo aur kisi card mein test codes daalo, jaise `TEST-001`.
4. Store (`localhost:3000`) par card kharido, wallet connect karo aur pay karo. 5-15 second mein code dikhna chahiye.
5. Ek baar pay karke turant tab band karo, aur admin panel mein dekho ki 10-20 second mein order "paid" hua ya nahi. Ye backup listener ka test hai.

---

## 2. Sab kuch Render par, free (testing ke liye sabse aasaan)

Ek hi Render service store, admin aur backend teeno chalati hai:
- Store: `https://<tumhari-service>.onrender.com/`
- Admin: `https://<tumhari-service>.onrender.com/admin/`

Steps:
1. Poora `tohfa` folder GitHub repo mein push karo (`.env` aur `node_modules` `.gitignore` ki wajah se upload nahi honge).
2. render.com par **New → Blueprint** mein jao aur repo chuno. `render.yaml` se service apne aap banegi (free plan).
3. Render ye values maangega: `RPC_URL` (Ankr Base Sepolia URL), `RECEIVING_WALLET`, `REOWN_PROJECT_ID`, `ADMIN_KEY`. `RPC_URL_2` khaali chhod sakte ho.
4. Deploy hone do. Pehli baar build mein 3-5 minute lagte hain.
5. **Reown dashboard** mein `<tumhari-service>.onrender.com` domain allow-list mein daalo.
6. `/admin/` kholo, login karo, codes daalo, phir store par test payment karo.

**Free plan mein ye dhyan rakho:**
- 15 minute koi request na aaye to service so jaati hai. Agli baar kholne par ~1 minute lagta hai.
- So kar jaagne, restart ya redeploy par **database reset ho jata hai**: orders aur codes mit jaate hain, aur sample cards wapas aa jaate hain. Test ke beech ek baar codes dobara daalne pad sakte hain.
- Asli paisa lene ke liye ye setup mat use karna. Tab paid plan + disk lo (neeche section 4 dekho).

---

## 3. Netlify (store + admin) + Render (backend), optional

### Step A: Code GitHub par daalo
Poora `tohfa` folder ek GitHub repo mein push karo. `.gitignore` pehle se hai, to `.env` aur `node_modules` upload nahi honge.

### Step B: Backend on Render
1. render.com → **New → Blueprint** → apna repo chuno. `render.yaml` se service ban jayegi. (Ye store/admin bhi serve karegi, koi dikkat nahi, tum Netlify wale URL use karna.)
2. Render ye values maangega: `RPC_URL`, `RECEIVING_WALLET`, `REOWN_PROJECT_ID`, `ADMIN_KEY` (aur optional `RPC_URL_2`).
3. Deploy ke baad URL milega, jaise `https://tohfa-backend.onrender.com`. Browser mein `.../api/health` kholo. `{"ok":true}` aaye to backend chal raha hai.

**Render free plan ki 2 limitations (testing ke liye theek, live ke liye nahi):**
- 15 minute koi request na aaye to server so jata hai. Agli request par ~1 minute mein jaagta hai. Sote waqt listener nahi chalta, lekin jaagne par jahan ruka tha wahan se aage padh leta hai.
- Restart ya redeploy par database (orders, codes) **delete** ho jata hai.

**Live ke liye:** Render ka paid plan (Starter) lo, `render.yaml` mein disk wala hissa uncomment karo, aur env mein `DB_PATH=/var/data/store.db` daalo. Ya backend kisi VPS par chalao.

### Step C: Store on Netlify
1. `store/netlify.toml` kholo aur `YOUR-BACKEND.onrender.com` ko apne Render URL se badlo. Commit + push karo.
2. Netlify → **Add new site → Import from Git** → repo chuno.
3. **Base directory:** `store`. Build command aur publish folder `netlify.toml` se apne aap aa jayenge.
4. Deploy.

### Step D: Admin on Netlify (alag site)
1. `admin/netlify.toml` mein bhi Render URL daalo.
2. Netlify par ek **aur** site banao, same repo, **Base directory:** `admin`.
3. Admin site ka URL kisi ko mat batana. Password (`ADMIN_KEY`) ke bina wo kuch nahi kar sakta, lekin phir bhi URL chhupa kar rakho.

### Step E: Aakhri settings
- Reown dashboard mein dono Netlify domains allow-list mein daalo (jaise `tohfa-store.netlify.app`).
- Netlify ka `/api` proxy calls ko Render tak pahunchata hai, isliye CORS set karne ki zaroorat nahi. Is setup mein Render env mein `TRUST_PROXY=2` kar dena, taaki rate-limit customer ka asli IP dekhe.
- Store site par `/api/admin/*` band hai. Admin API sirf admin site se chalegi.

---

## 4. Mainnet (asli paisa) par jaana
Render env mein:
```
NETWORK=base
RPC_URL=https://rpc.ankr.com/base/YOUR_ANKR_KEY
RPC_URL_2=https://mainnet.base.org     # optional, har payment do RPC se cross-check
RECEIVING_WALLET=0xAapkaAsliWallet
```
Render paid plan (Starter) lo, `render.yaml` mein disk wala hissa uncomment karo, aur `DB_PATH=/var/data/store.db` set karo, taaki orders aur codes delete na hon. Network badalne par purana database hata do. Pehle 1 USDC ka ek chhota asli order karke check karo.

---

## Payment kaise verify hoti hai
1. Customer card reserve karta hai. Server ek **unique amount** deta hai, jaise `9.7131 USDC`. Last 2 digit har open order ke liye alag hote hain, isi se order pehchana jata hai.
2. Customer wallet se pay karta hai. Browser txHash backend ko bhejta hai.
3. **Instant check:** backend Ankr se transaction padh kar check karta hai ki transaction successful hai aur confirm ho chuka hai, token asli USDC contract hai, paisa tumhare wallet mein aaya, amount exactly match karta hai, aur txHash pehle use nahi hua.
4. **Backup listener:** har 10 second tumhare wallet mein aaye USDC transfers padh kar amount se order match karta hai. Tab band ho jaye ya exchange se payment aaye, tab bhi order confirm hota hai.
5. Jo payment kisi order se match nahi hoti (galat amount, 24 ghante se late), wo admin panel mein **"Payments with no matching order"** mein dikhti hai.

Browser ki kisi baat par bharosa nahi kiya jata. Order tabhi paid hota hai jab blockchain confirm kare.

## Ankr free plan
Listener har 10 second 2 calls karta hai (~5 lakh/mahina), jo free plan ke andar hai. `POLL_INTERVAL_MS` 10000 se kam mat karna jab tak paid plan na ho.

## Dhyan rakhne wali baatein
- **Private key kabhi server par mat daalna.** Backend ko sirf wallet address chahiye.
- **Codes kahan se laoge:** sirf brand ya authorised distributor se. Anjaan source ke discount codes stolen ho sakte hain; brand unhe block kar sakta hai aur zimmedari tumhari hogi.
- **Tax/legal:** India mein crypto income par alag rules hain (30% tax, 1% TDS, kuch cases mein FIU registration). Launch se pehle CA se baat karo.
- **Refunds:** crypto payment reverse nahi hoti. Galat amount wali payments customer ko manually wapas bhejni padengi.
- Sample cards pehli baar apne aap bante hain. Admin panel mein unka "Shown" off karke apne asli cards add karo.
