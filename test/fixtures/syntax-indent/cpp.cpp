// A C++ fixture, as clang-format (LLVM, IndentWidth 4, AccessModifierOffset -4)
// formats it.
#include <string>
#include <vector>

namespace edwin {
namespace detail {
int helper(int x) { return x + 1; }
} // namespace detail

template <typename T> class Buffer : public Base {
public:
    Buffer(std::string name, int size) : name_(std::move(name)), size_(size) {}
    ~Buffer() override = default;

    T get(int i) const {
        if (i < 0) {
            throw std::out_of_range(
                "negative index into the buffer's contents");
        }
        return items_[i];
    }

private:
    std::string name_;
    int size_;
    std::vector<T> items_;
};

struct Point {
    int x;
    int y;
};

enum class Color { Red, Green, Blue };

int sum(const std::vector<int> &v) {
    int total = 0;
    for (auto x : v) {
        total += x;
    }
    auto f = [&](int a, int b) { return a + b; };
    switch (total) {
    case 0:
        return 0;
    default:
        break;
    }
    try {
        total = helper(total);
    } catch (const std::exception &e) {
        total = -1;
    }
    std::string s = "ünïcode";
    return f(total, 1);
}
} // namespace edwin

namespace {
auto make(int n) {
    auto g = [n](int a) {
        int b = a * n;
        return b + someFunctionWithALongName(a, b, n,
                                             "a long string argument here");
    };
    std::vector<int> v{1, 2, 3};
    if (n > 0) {
        return g(n);
    } else if (n < 0) {
        return g(-n);
    } else {
        return 0;
    }
}
} // namespace

class Widget {
public:
    explicit Widget(int x);

protected:
    virtual void draw() = 0;
};

struct Row : std::vector<int> {
    Row()
        : std::vector<int>(), x(0), yyyyyyyyyyyyyyyyyy(1),
          zzzzzzzzzzzzzzzzzzzzzz(2), wwwwwwwwwwww(3) {}
    Row(int aaaaaaaaaaaaaaaaaaaaaa, int bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb,
        int ccccccccccccccccccc)
        : x(aaaaaaaaaaaaaaaaaaaaaa), y(bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb) {
        f();
    }
    int x, y, yyyyyyyyyyyyyyyyyy, zzzzzzzzzzzzzzzzzzzzzz, wwwwwwwwwwww;
};
