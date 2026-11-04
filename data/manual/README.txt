MANUAL INDEX LEVELS FOR PRUINDEX INCOME BOOST

Use this folder when a source keeps refusing GitHub's daily fetch
(at the moment: S&P). Every run of "Fetch Income Boost Indices" merges
these files into data/income_boost_indices.json, and the levels stay in
the history even after a file is deleted.

S&P 500 FC TCA 0.50% Decrement Index (SGD)
  1. Open https://www.spglobal.com/spdji/en/indices/multi-asset/sp-500-fc-tca-050-decrement-index-sgd
  2. In the Performance chart, choose 10Y (the longest S&P gives).
  3. Click Export and save the file here as SPXFCSGD.xls
     (the name must start with SPXFCSGD; any later date in the name is fine).
  4. Commit and push, then run "Fetch Income Boost Indices".
  Repeat every few weeks (or monthly) to keep it current.

Other indices work the same way: start the file name with UBSMSTS or
BXIISC6S. .xls, .xlsx and .csv are read; any row with a date and a
positive number counts as a level.
