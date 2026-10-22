---
title: How the railcheck privacy check works
description: How railcheck scores a RAILGUN shield or unshield amount, what stays private, and what the check does not cover.
updated: 2026-10-22
---
# How the check works

How railcheck scores a shield or unshield amount, what stays private, and what the check does not cover.

## What stays private {#privacy}

Your amount and answers stay in this browser tab.

- railcheck does not send them to a server, put them in the URL or save them on your device.
- There is no wallet connection. There are no analytics and no third-party page resources.
- Every visitor gets the same pool file. The check verifies the hash of the file before it uses the data.
- The host can see your IP address when you load the page. A VPN or Tor can hide your IP address from the host. They do not remove all privacy risks.

## How the score is made {#method}

railcheck compares your amount with the RAILGUN WETH shields on Ethereum from the last 180 days. You do not say which shield is yours.

### For an unshield {#unshield}

Enter the amount before the 0.25% unshield fee.

1. railcheck looks for sets of 1, 2 or 3 shields that add up to your amount. It accepts a difference of up to 0.000005 ETH.
2. Each matching set gets a weight. Smaller sets get a higher weight. The check also includes the probability that no set is exact.
3. The strongest match sets the amount score. Many competing matches decrease it.
4. Your answers can set a minimum score:
   - The same address for the shield and the unshield: at least 100.
   - A past transfer between the two addresses: at least 90.
   - An unshield of the rest of a shield that you partly unshielded before: at least 90.
5. "Not sure" is unknown. railcheck does not use it as "no", and does not use it as a link. The result is then incomplete.

If the amount can be smaller, railcheck tries common amounts from 70% to 100% of your amount, largest first. It shows the first amount with a score of 5 or less. It scores a maximum of 6 amounts.

### For a shield {#shield}

Enter the amount that leaves your public wallet.

railcheck scores a later unshield of the full shield, with your shield added to the pool. If the amount can change a little, railcheck tries common amounts within 10% of your amount, nearest first. It shows the first amount with a score of 5 or less.

Wallets can run the same check. See [For wallets](/docs/).

## What the score means {#score}

The score goes from 0 to 100. The strongest signal sets it.

| Score | Band | Meaning |
| --- | --- | --- |
| 0–5 | Low | No strong amount match. |
| 6–20 | Medium | The amount points to a shield. |
| 21–50 | High | The amount gives a stronger link. |
| 51–100 | Critical | The amount or your answers give a strong signal. |

A match applies only if the matched shield is yours.

## Which data the check uses {#data}

The pool file contains the amount and the time of each shield. It contains no addresses.

- The data comes from Ethereum blocks with 64 confirmations or more.
- It includes WETH only. Swap outputs are in the file, but the score does not use them yet.
- Amounts are after the protocol fees.
- The data is updated each day. It is a snapshot, not a live feed. The page shows the date of the data.

The pool activity chart on the check page shows the last 3 days. Each square is 1 transaction. Shields go up and unshields go down. Unshields include unshields to DeFi contracts.

## What the check does not cover {#limits}

Data that is not on the chain can make the real risk higher, for example timing, IP addresses and exchange records.

- The score is the output of a model. It is not a measured probability of identification. A model can miss a real link.
- The check covers 180 days. Older shields and sets of more than 3 shields are not in the model.
- The model assumes that a broadcaster sends the unshield.
- railcheck asks about the remaining shielded amount. It does not check your other unshields.
- A low amount score does not remove a link between addresses.
- railcheck does not yet check swap outputs.

## What the words mean {#words}

- **Shield:** move tokens from a public address into your RAILGUN private balance.
- **Unshield:** move tokens from your private balance to a public address.
- **Pool amount:** the amount that the pool records for a shield, after the 0.25% shield fee.
- **Broadcaster:** a third party that sends an unshield transaction, so that your public address does not pay the gas.
- **Private balance:** the tokens that you hold in RAILGUN.

## Disclaimer {#disclaimer}

railcheck is an independent community project. It is not made by, affiliated with, or endorsed by [RAILGUN](https://railgun.org/) or its contributors.

It gives information only. It is not financial, legal or tax advice. It never holds, moves or has access to funds, and does not submit transactions.

The software is provided “as is” under the MIT license, without warranty. The contributors accept no liability for decisions or losses that follow from using it. A score can be wrong, and a Low score does not guarantee privacy.

railcheck exists to protect lawful financial privacy. It must not be used for, and does not support, money laundering, terrorist financing, sanctions evasion, fraud or any other illegal activity. You are responsible for following the laws that apply to you.
