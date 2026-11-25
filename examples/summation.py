# Sum of the integers from 1 to n with a for loop.
def main(n):
    total = 0
    for i in range(1, n + 1):
        total += i
    print(total)
    return total
