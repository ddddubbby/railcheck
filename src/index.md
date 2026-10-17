# railcheck: RAILGUN shield and unshield privacy check

railcheck tells you if a RAILGUN shield or unshield amount can link back to you, before you send. The check runs in your browser. It never asks for an address.

## What the check does

An unusual amount can show which shield is yours. railcheck compares your amount with the RAILGUN WETH shields on Ethereum from the last 180 days. It gives a risk score from 0 to 100.

## Inputs

- Action: shield or unshield.
- Amount in ETH. For an unshield, give the amount before the 0.25% fee.
- Can the amount change? Shield: within 10%. Unshield: down to 70%.
- Unshield only: three questions, each with yes, no or not sure:
  - Will you unshield to the address that shielded?
  - Did the recipient address ever send funds to the address that shielded, or get funds from it?
  - Will you unshield the rest of a shield that you partly unshielded before?
- Optional: your private balance.

## Result

- Status: clear, incomplete, attention or not checked.
- Score from 0 to 100, and a band: Low, Medium, High or Critical.
- The main finding, and a safer amount if one exists.

## Limits

- The check does not cover timing, IP addresses or data that is not on the chain.
- A Low score does not guarantee privacy.

## More

- [How it works](/how-it-works.md): method, data, privacy and limits.
- [For wallets](/docs.md): add the check to a wallet.
