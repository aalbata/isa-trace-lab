# Number of steps of the Collatz iteration, written without division.
def main(n):
    steps = 0
    while n != 1 and steps < 200:
        if n & 1 == 0:
            n = n >> 1
        else:
            n = 3 * n + 1
        steps += 1
    return steps
