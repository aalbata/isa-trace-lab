# Fill an array with squares, then replace it by its prefix sums.
def main(n):
    squares = [0] * 10
    for i in range(10):
        squares[i] = (i + n) * (i + n)
    for i in range(1, 10):
        squares[i] += squares[i - 1]
    print(squares[9])
    return squares[9]
