# railcheck: RAILGUN shield and unshield privacy check

railcheck tells you if a RAILGUN shield or unshield amount can link back to you, before you send. The check runs in your browser. It never asks for an address.

## What the check does

An unusual amount can show which shield is yours. railcheck compares your amount with the RAILGUN WETH, USDT or USDC shields on Ethereum from the last 180 days. It gives a risk score from 0 to 100.

## Inputs

- Token: WETH, USDT, USDC or Other, on Ethereum. Other is not covered. A token whose pool data did not load is not covered either.
- Action: shield or unshield.
- Amount to shield or unshield: in ETH for WETH, in USDT or USDC for those tokens. For an unshield, give the amount before the 0.25% fee.
- Shield: "Can you adjust the amount?" No, or yes within 10%.
- Unshield: "Can the amount be smaller?" No, or yes down to 70%.
- Unshield only, optional under "Link questions": four questions, each with yes, no or "?" (not sure, the default):
  - Will you unshield to the address that shielded?
  - Has the recipient ever sent to or received from the shielding address?
  - Does this unshield the rest of a shield?
  - Did a public wallet pay gas for your private swap?
- Unshield only, optional: your private balance.

## Result

- Shield risk or Unshield risk: a score from 0 to 100, and a band: Low, Medium, High or Critical. An incomplete result shows "Incomplete" in place of the band. A check that cannot run shows "Not checked" and no score.
- Three parts, each with a dot: filled is an issue found, "?" is unknown, empty is no issue found.
  - Amount: the amount stands out or blends in.
  - Links: unshield only. A link found, unknown, or none reported.
  - Coverage: limited or complete.
- A one-line verdict, for example "This amount stands out." or "Not fully checked. No amount issue."
- Matches: the shields an unshield of this amount can be linked to, alone or as a set that adds up to it. Each row shows the amount sent before the shield fee, the date in UTC, and a tag: Shield or Swap output.
- A safer amount, when the amount needs attention, can change and no address link is found: a button such as "Use 4987.5 USDT (score 1)". If none scores Low, the result says so.
- Unshield with a balance: the balance left.
- "What does this mean?" explains the result.

## Limits

- The check does not cover timing, IP addresses or data that is not on the chain.
- A Low score does not guarantee privacy.

## More

- [How it works](/how-it-works.md): method, data, privacy and limits.
- [For wallets](/docs.md): add the check to a wallet.
