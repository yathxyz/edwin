// A C# fixture, as CSharpier formats it.
using System;
using System.Collections.Generic;
using System.Linq;

namespace Edwin.Fixture;

/// <summary>
/// A documentation comment.
/// </summary>
public class Buffer<T> : IDisposable
    where T : IComparable<T>
{
    private readonly List<T> items = new();
    public string Name { get; set; } = "";
    public int Count
    {
        get { return items.Count; }
    }

    public Buffer(string name)
    {
        Name = name;
    }

    public T Get(int i)
    {
        if (i < 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(i),
                "a negative index into the buffer's contents"
            );
        }
        else if (i >= Count)
        {
            return default;
        }
        else
        {
            return items[i];
        }
    }

    public void Run()
    {
        foreach (var item in items)
        {
            Console.WriteLine(item);
        }
        for (int i = 0; i < 10; i++)
        {
            continue;
        }
        while (true)
        {
            break;
        }
        switch (Count)
        {
            case 0:
                Console.WriteLine("zero");
                break;
            default:
                break;
        }
        var kind = Count switch
        {
            0 => "none",
            1 => "one",
            _ => "many",
        };
        try
        {
            Run();
        }
        catch (Exception e)
        {
            Console.WriteLine(e);
        }
        finally
        {
            Dispose();
        }
        Action<int> f = x =>
        {
            Console.WriteLine(x);
        };
        var query = items.Where(x => x != null).Select(x => x.ToString()).OrderBy(x => x).ToList();
        var text = """
            a raw string,
              its blanks kept
            """;
        var verbatim =
            @"a verbatim
  string";
        var anon = new { A = 1, B = "ünïcode" };
    }

    public void Dispose() { }
}

public record Point(int X, int Y);

public enum Color
{
    Red,
    Green,
}

public interface IShape
{
    double Area();
}
