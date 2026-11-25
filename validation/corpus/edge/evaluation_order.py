# The right-hand side is evaluated before the index of the target.
def main(i, s):
    a = [1, 2, 3, 4]
    a[i] = 1 << s
    a[0] = a[i] + a[3 - i]
    a[i] += a[0] << (s & 3)
    print(a[0])
    return a[i]
