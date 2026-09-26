# AI token billing: setup (BSC mainnet, asli USDT)

Customer apne wallet se USDT **approve** karta hai aur apni **limits** set karta hai (per charge aur per 30 din).
Tum admin panel mein usage record karke **Charge** dabate ho. Server ka keeper wallet contract ko bolta hai,
aur contract limits ke andar USDT customer se treasury mein bhej deta hai.

Remix ki zaroorat nahi: contract **admin panel ke "Deploy contract" page** se deploy hota hai.

## Teen wallets

| Wallet | Kaam | Kahan |
|---|---|---|
| **Owner** | Deploy karta hai; pause, keeper/treasury badalna | Tumhara MetaMask. Iski key **kabhi server par nahi** |
| **Keeper** | Sirf charge trigger karta hai | Deploy page naya bana deta hai. Key Render mein jaati hai |
| **Treasury** | Saara paisa isme aata hai | Default: store ka `RECEIVING_WALLET` |

Keeper ki key chori ho bhi jaye to chor paisa apne paas nahi le ja sakta: contract paisa sirf treasury
mein bhejta hai, aur har customer ki limit se zyada nahi. Tab owner wallet se pause karke keeper badal do.

## Step 1: Deploy (5 minute)

1. MetaMask (computer par extension) mein **BNB Smart Chain** network chuno, aur owner wallet mein ₹100-200 ka **BNB** rakho.
2. Admin panel kholo → upar **Deploy contract**.
3. **Connect MetaMask.** Galat network ho to "Switch to BNB Smart Chain" dabao.
4. **Create a new keeper wallet** dabao. Jo private key dikhe use copy karke safe jagah save karo, phir "I saved the private key" tick karo.
5. Treasury pehle se store ka receiving wallet hota hai. Chaho to badal lo.
6. **Deploy contract** dabao, MetaMask mein confirm karo. Kuch second mein contract address aa jayega.
7. **Send to keeper** se keeper ko 0.005 BNB bhejo (charges ki gas ke liye, kaafi mahino chalega).
8. Page ke neeche jo lines dikhti hain unhe **Copy all** karo.

## Step 2: Render

Render → Environment mein add karo (Step 1 ki copied lines + ek aur):

| Key | Value |
|---|---|
| `BILLING_CONTRACT` | deploy page se |
| `KEEPER_PRIVATE_KEY` | deploy page se |
| `SERVICE_API_KEY` | koi lamba password (tumhari AI service ke liye) |

`NETWORK` = `bsc` hona chahiye. Save karo aur redeploy hone do.

Admin panel → **AI token billing** mein "Running", keeper gas mein BNB, aur koi laal error nahi dikhna chahiye.

## Step 3: Pehla asli test (apne doosre wallet se, 2-5 USDT)

1. Doosre wallet mein **BSC par 5 USDT** + thoda BNB rakho.
2. Store par **AI tokens** (`/ai.html`) kholo, wallet connect karo.
3. Limits chhoti rakho: per charge **2**, per 30 days **5**, approval **10**. **Approve** → **Activate** → **Sign in**.
4. Admin → **Record usage**: wo wallet chuno, **500000** tokens (default price par 1 USDT). Add.
5. Customers table mein **Charge** dabao. Status **paid** aur BscScan link aayega; treasury mein 1 USDT.
6. Limit check: 3 USDT ka usage daal ke charge karo. Sirf **2** katne chahiye.

## BscScan par verify (optional, customers ke bharose ke liye)

BscScan → contract address → **Contract** → **Verify and Publish**:
- Compiler type: Solidity (Single file), version **v0.8.26**, license MIT
- Optimization: **Yes**, runs **200**, EVM version **paris**
- Code: `contracts/TokenBilling.sol` ka poora code
- Constructor arguments: BscScan khud pakad leta hai

## Tumhari AI service ke liye API

Header: `x-service-key: <SERVICE_API_KEY>`

```
POST /api/service/check   { "apiKey": "sk_..." }
  -> { "ok": true, "wallet": "0x...", "creditLeft": "18.50", "tokensLeft": 9250000, "due": "11.50" }

POST /api/service/usage   { "apiKey": "sk_...", "tokens": 1532, "note": "chat" }
  -> { "cost": "0.0031", "due": "11.5031", "creditLeft": "18.4969", "tokensLeft": 9248468, "stop": false }
```

**Har request se pehle `check` karo, aur `ok: false` ho to serve mat karo.** `tokensLeft` se zyada ek request mein mat do.
`usage` ka jawab `stop: true` de to agli request serve mat karo.

"Credit left" = customer se abhi kitna le sakte hain (approval, wallet balance aur 30-din ki limit mein se jo sabse kam ho) minus jo pehle se due hai.
Customer apne wallet (Bitget, MetaMask, Trust) mein approval kabhi bhi kam ya zero kar sakta hai, isliye server ise har baar blockchain se dobara padhta hai (15 second cache).
Default: customer ke liye **No spending limit** aur **Unlimited approval** pehle se tick hote hain (customer chahe to untick karke apni limit laga sakta hai). Admin → Billing settings → **Minimum approval**: 0 (default) = koi minimum nahi (customer jitna chahe approve kare). Koi number daaloge to usse kam approval par API key kaam nahi karegi.

Usage se sirf "Due" badhta hai; paisa tabhi katta hai jab tum admin se **Charge** dabate ho.

> Asli customers se pehle contract kisi experienced Solidity developer se ek baar review karwa lena.
> Deploy ke baad contract badla nahi ja sakta.
