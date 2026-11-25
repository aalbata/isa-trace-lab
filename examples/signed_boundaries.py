# 32-bit wraparound at the signed boundaries.
def main():
    top = 2147483647
    wrapped = top + 1
    print(wrapped)
    bottom = -2147483648
    print(bottom - 1)
    print(-bottom)
    print(65536 * 65536)
    print(46341 * 46341)
    return wrapped
