# Loops whose bounds lie at the limits of the 32-bit range.
def main():
    n = 0
    last = 0
    for i in range(2147483600, 2147483647, 7):
        n += 1
        last = i
    print(n)
    print(last)
    for i in range(-2147483648, 2147483647, 1000000000):
        n += 1
        last = i
    print(n)
    print(last)
    for i in range(2147483647, -2147483648, -900000000):
        n += 1
        last = i
    print(n)
    print(last)
    for i in range(-2147483640, -2147483648, -3):
        n += 1
        last = i
    print(n)
    print(last)
    for i in range(1, 2, 2147483647):
        n += 100
    for i in range(-1, -2, -2147483648):
        n += 1000
    for i in range(5, 5):
        n += 10000
    for i in range(2147483646, 2147483647):
        last = i
    print(last)
    return n
