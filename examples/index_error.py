# A runtime error: the index reaches the length of the array.
def main(n):
    a = [10, 20, 30]
    total = 0
    for i in range(n):
        total += a[i]
    return total
