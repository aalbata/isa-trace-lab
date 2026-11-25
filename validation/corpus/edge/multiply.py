# Products at the boundaries of the 32-bit range.
def main(a, b):
    print(a * b)
    print(a * -1)
    print(b * 65536)
    print(a * a)
    print(-2147483648 * -1)
    print(65536 * 65536)
    print(46341 * 46341)
    print(a * 0)
    print(3 * b)
    return (a * b) * (a - b)
