# Iterative Fibonacci numbers; fib(47) no longer fits in 32 signed bits.
def main(n):
    a = 0
    b = 1
    for i in range(n):
        t = a + b
        a = b
        b = t
    print(a)
    return a
