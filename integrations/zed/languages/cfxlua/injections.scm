(((comment) @_luacats_comment
  (#match? @_luacats_comment "^---")) @injection.content
  (#set! injection.language "luacats"))

((comment) @injection.content
  (#set! injection.language "comment"))
