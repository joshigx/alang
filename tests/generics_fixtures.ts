// Fixtures of docs/plans/generics.md (section 4), shared by the generics tests.

export const UTIL = `fn util.last<T>
  doc: "The last item of the list, if any."
  in:
    list: List<T>
  out: Option<T>
  effects: none
  requires: none
  ensures: none
  examples:
    last(list: [1, 2, 3]) == Some(3)
    last(list: ["a"]) == Some("a")
    last(list: std.list.empty<Int>()) == None
  body:
    return std.list.get(list: list, index: std.list.length(list: list) - 1)
end fn util.last

fn util.count_if<T>
  doc: "How many items of the list pass the test."
  in:
    list: List<T>
    test: (T) -> Bool
  out: Int
  effects: none
  requires: none
  ensures: result <= std.list.length(list: list)
  examples:
    count_if(list: [1, 5, 9], test: fn(n: Int): Bool => n > 2) == 2
    count_if(list: ["a", ""], test: fn(s: String): Bool => s == "") == 1
  body:
    let kept: List<T> = std.list.filter(list: list, with: fn(item: T): Bool => test(item))
    return std.list.length(list: kept)
end fn util.count_if

fn util.repeat<T>
  doc: "The item, count times."
  in:
    item: T
    count: Int
  out: List<T>
  effects: none
  requires: count >= 0
  ensures: std.list.length(list: result) == count
  examples:
    repeat(item: "x", count: 3) == ["x", "x", "x"]
    repeat(item: 7, count: 0) == std.list.empty<Int>()
  body:
    if count == 0 then
      return std.list.empty<T>()
    end if
    return std.list.concat(left: [item], right: repeat(item: item, count: count - 1))
end fn util.repeat

fn util.none_list<T>
  doc: "The empty list of any item type."
  in: none
  out: List<T>
  effects: none
  requires: none
  ensures: none
  examples:
    none_list<Int>() == std.list.empty<Int>()
  body:
    return std.list.empty<T>()
end fn util.none_list
`;

export const TYPE_T = `type m.T
  doc: "A tag."
  record:
    n: Int
  where: none
end type m.T`;

export const KEEP = `fn m.keep<T>
  doc: "The item, whatever the tag."
  in:
    item: T
    tag: m.T
  out: T
  effects: none
  requires: none
  ensures: none
  examples:
    keep(item: 1, tag: m.T(n: 2)) == 1
  body:
    return item
end fn m.keep`;

export const HIDE = `${TYPE_T}\n\n${KEEP}\n`;
