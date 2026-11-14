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

export const FIRST_SOME = `fn util.first_some<T>
  doc: "The first option that holds a value, or None."
  in:
    first: Option<T>
    second: Option<T>
  out: Option<T>
  effects: none
  requires: none
  ensures: none
  examples:
    first_some(first: Some(1), second: Some(2)) == Some(1)
    first_some(first: None<Int>, second: Some(2)) == Some(2)
    first_some(first: None<String>, second: None) == None
  body:
    if first == None then
      return second
    end if
    return first
end fn util.first_some
`;

// The spec block of 7.3 (`Tree`, `Branch`, `items`) and `insert`.
export const TREE = `type tree.Tree<T>
  doc: "A binary tree: a leaf, or a node with an item and a tree on either side."
  variant:
    Leaf
    Node: Branch<T>
  where: none
end type tree.Tree

type tree.Branch<T>
  doc: "A node of a tree: its item, and the trees left and right of it."
  record:
    item: T
    left: Tree<T>
    right: Tree<T>
  where: none
end type tree.Branch

fn tree.items<T>
  doc: "The items of the tree from left to right."
  in:
    tree: Tree<T>
  out: List<T>
  effects: none
  requires: none
  ensures: none
  examples:
    items(tree: Leaf<Int>) == std.list.empty<Int>()
    items(tree: Node(Branch(item: "b", left: Leaf, right: Node(Branch(item: "c", left: Leaf, right: Leaf))))) == ["b", "c"]
  body:
    let parts: List<List<T>> = match tree
      case Leaf then
        std.list.empty<List<T>>()
      case Node(branch) then
        [items(tree: branch.left), [branch.item], items(tree: branch.right)]
    end match
    return std.list.flatten(lists: parts)
end fn tree.items

fn tree.insert<T>
  doc: "The tree with the item added in order: smaller items go left."
  in:
    tree: Tree<T>
    item: T
    by: (T, T) -> Order
  out: Tree<T>
  effects: none
  requires: none
  ensures: none
  examples:
    insert(tree: Leaf<Int>, item: 2, by: std.int.compare) == Node(Branch(item: 2, left: Leaf, right: Leaf))
    insert(tree: insert(tree: Leaf<String>, item: "b", by: std.string.compare), item: "a", by: std.string.compare) == Node(Branch(item: "b", left: Node(Branch(item: "a", left: Leaf, right: Leaf)), right: Leaf))
  body:
    let grown: Tree<T> = match tree
      case Leaf then
        Node(Branch(item: item, left: Leaf, right: Leaf))
      case Node(branch) then
        if by(item, branch.item) == Less then
          Node(Branch(item: branch.item, left: insert(tree: branch.left, item: item, by: by), right: branch.right))
        else
          Node(Branch(item: branch.item, left: branch.left, right: insert(tree: branch.right, item: item, by: by)))
        end if
    end match
    return grown
end fn tree.insert
`;

export const PAIR = `type m.Pair<A, B>
  doc: "Two values."
  record:
    left: A
    right: B
  where: none
end type m.Pair
`;
