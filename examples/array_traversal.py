# Sum and maximum of a fixed-length array.
def main():
    data = [12, -7, 30, 5, 18, -2, 9, 21]
    total = 0
    largest = data[0]
    for i in range(len(data)):
        total += data[i]
        if data[i] > largest:
            largest = data[i]
    print(total)
    print(largest)
    return largest
