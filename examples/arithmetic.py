# Arithmetic with small and large constants.
def main(a, b):
    s = a + b
    d = a - b
    p = a * b
    big = 100000 + s
    print(s)
    print(d)
    print(p)
    return big - 4096
