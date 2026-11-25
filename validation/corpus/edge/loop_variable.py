# Assignments to the loop variable do not change the iteration; the variable keeps its last value.
def main(n):
    i = -7
    total = 0
    for i in range(n):
        total += i
        i = i * 10
        total += i
    print(i)
    for j in range(3):
        for i in range(j):
            total += 1
    print(i)
    return total
