# Bitwise operators and shifts.
def main(x):
    low = x & 0xFF
    high = (x >> 8) & 0xFF
    swapped = (low << 8) | high
    print(swapped)
    print(x ^ -1)
    print(~x)
    print(-x >> 2)
    return swapped ^ x
