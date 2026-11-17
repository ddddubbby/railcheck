---
title: How railcheck works: RAILGUN privacy scoring & limits
description: Learn how railcheck scores RAILGUN shield and unshield amounts, what stays in your browser, and the model's limits.
updated: 2026-11-17
---
# How railcheck works

How railcheck scores RAILGUN shield and unshield amounts, what stays private in your browser, and where the model stops.

## What stays private {#privacy}

Your amount and answers stay in this browser tab.

- Nothing leaves your browser: railcheck never sends your inputs to a server, writes them to the URL, or stores them on your device.
- There is no wallet connection, no analytics, and no third-party page resources.
- Every visitor downloads the same WETH, USDT, and USDC pool files regardless of which token you pick, so network requests don't reveal what you're checking. Each file's SHA-256 hash is verified before use.
- Like any website, the host can see your IP address when you load the page. A VPN or Tor hides your IP from the host, though neither eliminates every privacy risk.

## How scoring works {#method}

railcheck compares your amount against the last 180 days of Ethereum RAILGUN shields for WETH, USDT, or USDC—without you ever specifying which shield is yours.

### For an unshield {#unshield}

Enter the amount before the 0.25% unshield fee.

1. railcheck searches for combinations of 1, 2, or 3 shields that sum to your amount (within ±0.000005 ETH for WETH; exact for USDT and USDC).
2. Each matching combination gets a weight—smaller sets weigh more—alongside the probability that no match is exact.
3. The strongest match sets the amount score, while many competing matches pull it down.
4. Optional answers under "Address links" can set a minimum score:
   - Unshielding to the same address that shielded: at least 100.
   - A past transfer between the shielding and recipient addresses: at least 90.
   - Spending the remainder of a shield you partly unshielded before: at least 90.
     Example: you shielded 9.12 ETH, unshielded 3 ETH, and now unshield 6.12 ETH.
   - A public wallet paid the gas for the private swap behind the output you're unshielding: at least 90.
5. "?" (not sure) is the default. railcheck treats it as unknown—never as "no" and never as a confirmed link—so a low amount score shows as Incomplete rather than clear. The swap gas answer applies only when a swap output sets the score.

Swap outputs can raise a score but never lower it, because the check can't tell whether a swap output belongs to you.

If your amount is flexible, railcheck tests common amounts from 70% to 100% of your amount (largest first, up to 6 candidates) and shows the first one scoring 5 or less.

### For a shield {#shield}

Enter the amount leaving your public wallet.

railcheck simulates unshielding the entire deposit later with your shield added to the pool. If your amount is flexible, it tests common pool amounts within ±10% (closest first) and recommends the first one scoring 5 or less.

Wallets can embed the same check directly. See [For wallets](/docs/).

## What the score means {#score}

Scores run from 0 to 100, driven by the strongest signal.

| Score | Band | Meaning |
| --- | --- | --- |
| 0–5 | Low | No strong amount match. |
| 6–20 | Medium | The amount points toward a shield. |
| 21–50 | High | The amount points strongly toward a shield. |
| 51–100 | Critical | The amount or your answers create a strong link signal. |

A numerical match only reveals a link if the matched shield actually belongs to you.

## Pool data {#data}

Each pool file stores only the amount and timestamp of each shield, with no addresses.

- Data comes from Ethereum blocks with 64 or more confirmations.
- Covers WETH, USDT, and USDC—one pool per token, swap outputs included. A token is active only when its pool spans the full 180 days.
- Amounts are recorded after protocol fees.
- Pool files update daily as a static snapshot rather than a live feed; the page footer shows the snapshot date.

The pool activity chart on the check page shows the last 3 days, where each square represents 1 transaction. Shields stack up and unshields (including DeFi unshields) stack down.

## Limitations {#limits}

Off-chain data and timing—such as when you shield vs. unshield, IP addresses, and exchange records—can create real linking risk that this check can't see.

- The score comes from a heuristic model, not a true probability of identification, and can miss real links.
- Only shields from the last 180 days and sets of up to 3 shields are included.
- The model assumes a Broadcaster submits the unshield.
- railcheck asks about spending the rest of a shield, not your other separate unshields.
- A low amount score doesn't override an address link.
- Public shields are recorded as one total per transaction. If a single shield transaction contained multiple notes, unshielding just one note won't match.

## Glossary {#words}

- **Shield:** move tokens from a public 0x address into your RAILGUN private balance.
- **Unshield:** move tokens from your RAILGUN private balance out to a public 0x address.
- **Pool amount:** the net amount recorded after the 0.25% shield fee.
- **Broadcaster:** a third party that submits an unshield transaction so your public address doesn't pay the gas.
- **Private balance:** your shielded tokens inside RAILGUN.
- **Swap output:** the new shielded note created at the end of a private swap. Because its amount appears on-chain, a matching unshield can link to it.
- **In the SDK and pool data:** the SDK calls shields "deposits" (as in `deposits` and `restOfDeposit`), and raw pool rows call swap outputs "reshields".

## Disclaimer {#disclaimer}

railcheck is an independent community project. It is not made by, affiliated with, or endorsed by [RAILGUN](https://railgun.org/) or its contributors.

railcheck provides information only—not financial, legal, or tax advice. It never holds or accesses funds and never submits transactions.

The software is provided “as is” under the MIT license, without warranty. The contributors accept no liability for decisions or losses that follow from using it. A score can be wrong, and a low score doesn't guarantee privacy.

railcheck exists to protect lawful financial privacy. It must not be used for, and does not support, money laundering, terrorist financing, sanctions evasion, fraud, or any other illegal activity. You are responsible for following the laws that apply to you.
