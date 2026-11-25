# Every legal shift count on boundary values; an illegal count ends the program.
def main(x, count):
    acc = 0
    for s in range(32):
        acc ^= (x << s)
        acc += (x >> s)
    print(acc)
    print(x << 31)
    print(x >> 31)
    print(1 << 31)
    print(-1 >> 1)
    print(-2147483648 >> 31)
    y = x
    y <<= 4
    y >>= 2
    print(y)
    return x << count
