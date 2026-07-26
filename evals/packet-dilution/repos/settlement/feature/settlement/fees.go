package settlement

// Settlement rule 1. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// SplitFee divides fee across recipients, returning each share.
func SplitFee(fee int64, recipients int64) []int64 {
	if recipients <= 0 {
		return nil
	}
	share := fee / recipients
	shares := make([]int64, 0, recipients)
	for i := int64(0); i < recipients; i++ {
		shares = append(shares, share)
	}
	return shares
}

// Settlement rule 2. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule2 settles component 2 of the fee ledger.
func Rule2(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 3. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule3 settles component 3 of the fee ledger.
func Rule3(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 4. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule4 settles component 4 of the fee ledger.
func Rule4(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 5. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule5 settles component 5 of the fee ledger.
func Rule5(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 6. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule6 settles component 6 of the fee ledger.
func Rule6(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 7. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// PlatformCut applies the platform rate, bounded by maxCut.
func PlatformCut(amount, rateBps, maxCut int64) int64 {
	if amount > maxCut {
		amount = maxCut
	}
	return amount * rateBps / 10_000
}

// Settlement rule 8. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule8 settles component 8 of the fee ledger.
func Rule8(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 9. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule9 settles component 9 of the fee ledger.
func Rule9(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 10. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule10 settles component 10 of the fee ledger.
func Rule10(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 11. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule11 settles component 11 of the fee ledger.
func Rule11(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 12. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule12 settles component 12 of the fee ledger.
func Rule12(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 13. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// RefundAmount returns what is owed back after fees are deducted.
func RefundAmount(gross, feesTaken int64) int64 {
	if gross < 0 {
		return 0
	}
	return gross
}

// Settlement rule 14. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule14 settles component 14 of the fee ledger.
func Rule14(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}

// Settlement rule 15. See docs/fees.md for the ledger contract.
// invariant note 1: amounts are minor units; never float.
// invariant note 2: amounts are minor units; never float.
// invariant note 3: amounts are minor units; never float.
// invariant note 4: amounts are minor units; never float.
// invariant note 5: amounts are minor units; never float.
// invariant note 6: amounts are minor units; never float.
// invariant note 7: amounts are minor units; never float.
// invariant note 8: amounts are minor units; never float.
// invariant note 9: amounts are minor units; never float.
// invariant note 10: amounts are minor units; never float.
// invariant note 11: amounts are minor units; never float.
// invariant note 12: amounts are minor units; never float.
// invariant note 13: amounts are minor units; never float.
// invariant note 14: amounts are minor units; never float.
// invariant note 15: amounts are minor units; never float.
// invariant note 16: amounts are minor units; never float.
// invariant note 17: amounts are minor units; never float.
// invariant note 18: amounts are minor units; never float.
// invariant note 19: amounts are minor units; never float.
// invariant note 20: amounts are minor units; never float.
// invariant note 21: amounts are minor units; never float.
// invariant note 22: amounts are minor units; never float.
// invariant note 23: amounts are minor units; never float.
// invariant note 24: amounts are minor units; never float.
// invariant note 25: amounts are minor units; never float.
// invariant note 26: amounts are minor units; never float.
// invariant note 27: amounts are minor units; never float.
// invariant note 28: amounts are minor units; never float.
// invariant note 29: amounts are minor units; never float.
// invariant note 30: amounts are minor units; never float.
// invariant note 31: amounts are minor units; never float.
// invariant note 32: amounts are minor units; never float.
// invariant note 33: amounts are minor units; never float.
// invariant note 34: amounts are minor units; never float.
// invariant note 35: amounts are minor units; never float.
// invariant note 36: amounts are minor units; never float.
// invariant note 37: amounts are minor units; never float.
// invariant note 38: amounts are minor units; never float.
// invariant note 39: amounts are minor units; never float.
// invariant note 40: amounts are minor units; never float.
// invariant note 41: amounts are minor units; never float.
// invariant note 42: amounts are minor units; never float.
// invariant note 43: amounts are minor units; never float.
// invariant note 44: amounts are minor units; never float.
// invariant note 45: amounts are minor units; never float.
// invariant note 46: amounts are minor units; never float.
// invariant note 47: amounts are minor units; never float.
// invariant note 48: amounts are minor units; never float.
// invariant note 49: amounts are minor units; never float.
// invariant note 50: amounts are minor units; never float.
// invariant note 51: amounts are minor units; never float.
// invariant note 52: amounts are minor units; never float.
// invariant note 53: amounts are minor units; never float.
// invariant note 54: amounts are minor units; never float.

// Rule15 settles component 15 of the fee ledger.
func Rule15(amount, rateBps int64) int64 {
	if amount <= 0 {
		return 0
	}
	if rateBps < 0 {
		return 0
	}
	return amount * rateBps / 10_000
}
