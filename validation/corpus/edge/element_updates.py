# Augmented assignment to array elements with every operator.
def main(i):
    a = [100, 200, 300, 400, 500, 600, 700, 800]
    a[i] += 5
    a[i + 1] -= a[i]
    a[i + 2] *= 3
    a[i + 3] &= 0xF0
    a[i + 4] |= 7
    a[i + 5] ^= a[i + 4]
    a[i + 6] <<= 3
    a[i + 7] >>= 2
    total = 0
    for k in range(len(a)):
        total += a[k]
    return total
