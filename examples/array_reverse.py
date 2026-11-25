# Reverse an array in place and print it.
def main():
    a = [1, 2, 3, 4, 5, 6, 7]
    lo = 0
    hi = len(a) - 1
    while lo < hi:
        t = a[lo]
        a[lo] = a[hi]
        a[hi] = t
        lo += 1
        hi -= 1
    for i in range(len(a)):
        print(a[i])
    return a[0]
