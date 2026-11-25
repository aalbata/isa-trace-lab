# Nested loops with break and continue.
def main(n):
    count = 0
    for i in range(n):
        j = 0
        while j < n:
            j += 1
            if j == i:
                continue
            if j > i + 2:
                break
            for k in range(j, 0, -1):
                if k == 2:
                    break
                count += k
        if i == 6:
            break
    print(count)
    return count * 2 + 1
