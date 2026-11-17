# railcheck: RAILGUN shield and unshield privacy check

Check whether a RAILGUN shield or unshield (deposit or withdrawal) amount could link back to you before you send. Everything runs in your browser without asking for an address.

## What the check does

An unusual amount can give away which deposit is yours. railcheck compares your amount against the last 180 days of RAILGUN WETH, USDT, and USDC shields on Ethereum and scores the risk from 0 to 100.

## Inputs

- Token: WETH, USDT, USDC, or Other on Ethereum. Other tokens aren't supported, and tokens whose pool data failed to load or is incomplete are unavailable.
- Action: shield or unshield.
- Amount to shield or unshield: in ETH for WETH, or in USDT/USDC for those tokens. For an unshield, enter the amount before the 0.25% fee.
- "Is this amount flexible?"
  - Shield: "No, fixed" or "Yes, within 10%".
  - Unshield: "No, fixed" or "Yes, down to 70%".
- Unshield only, optional under "Address links": four questions, each with yes, no, or "?" (not sure, the default):
  - Unshielding to the same address that shielded?
  - Have the shielding and recipient addresses transacted before?
  - Unshielding the rest of an earlier shield?
  - Did a public wallet pay gas for a private swap?
- Unshield only, optional: your private balance.

## Result

- Shield risk or Unshield risk: a score from 0 to 100, and a band: Low, Medium, High, or Critical. An incomplete result shows "Incomplete" instead of the band; a check that couldn't run shows "Not checked" with no score.
- Three status dots: filled means an issue was found, "?" means unknown, and empty means clear.
  - Amount: whether the amount stands out or blends in.
  - Links (unshield only): whether a link was found, unknown, or none reported.
  - Coverage: limited or complete.
- A one-line verdict, such as "This amount stands out." or "Amount blends in; other checks are incomplete."
- Matches: shields that an unshield of this amount could link to, either individually or as a combination that sums to it. Each row shows the amount sent before the shield fee, the UTC date, and a tag (Shield or Swap output).
- A safer amount, when the amount needs attention, is flexible, and no address link is found: a button such as "Use 4987.5 USDT (score 1)", or a note if no low-risk amount was found.
- Unshield with a balance: the remaining balance.
- "What does this mean?" explains the breakdown.

## Limits

- The check doesn't cover timing, IP addresses, or off-chain data.
- A low score doesn't guarantee privacy.

## More

- [How it works](/how-it-works.md): scoring method, pool data, privacy, and limits.
- [For wallets](/docs.md): add local privacy checks to a wallet.
