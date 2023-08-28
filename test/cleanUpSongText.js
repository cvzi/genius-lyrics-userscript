const assert = require('assert')

function cleanUpSongTitle (songTitle) {
  // Remove featuring artists and version info from song title
  songTitle = songTitle.replace(/\((master|studio|stereo|mono|anniversary|digital|edition|naked|original|re|ed|no.*?\d+|mix|version|\d+th|\d{4}|\s|\.|-|\/)+\)/i, '').trim()
  songTitle = songTitle.replace(/[-‧⋅·ᐧ•‐‒–—―﹘]\s*(master|studio|stereo|mono|anniversary|digital|edition|naked|original|re|ed|no.*?\d+|mix|version|\d+th|\d{4}|\s|\.|-|\/)+/i, '').trim()
  songTitle = songTitle.replace(/fe?a?t\.?u?r?i?n?g?\s+[^)]+/i, '')
  songTitle = songTitle.replace(/\(\s*\)/, ' ').replace('"', ' ').replace('[', ' ').replace(']', ' ').replace('|', ' ')
  songTitle = songTitle.replace(/\s\s+/, ' ')
  songTitle = songTitle.replace(/[\u200B-\u200D\uFEFF]/g, '') // zero width spaces
  songTitle = songTitle.trim()
  return songTitle
}

function testCleanUpSongTitle () {
  console.log('testCleanUpSongTitle()...')

  const cases = [
    ['Come Together (Remastered 2009)', 'Come Together'],
    ["Don't Let Me Down (Naked Version / Remastered 2013)", "Don't Let Me Down"],
    ['Strawberry Fields Forever (Stereo Mix 2015)', 'Strawberry Fields Forever'],
    ['Penny Lane (Stereo Mix 2017)', 'Penny Lane'],
    ["I Want You (She's So Heavy) (Remastered 2009)", "I Want You (She's So Heavy)"],
    ['Lucy In The Sky With Diamonds (Original Mono Mix - No. 11)', 'Lucy In The Sky With Diamonds'],
    ['Norwegian Wood (This Bird Has Flown) (Remastered 2009)', 'Norwegian Wood (This Bird Has Flown)'],
    ['She Loves You (Mono Version / Remastered 2009)', 'She Loves You'],
    ['Sympathy For The Devil (50th Anniversary Edition)', 'Sympathy For The Devil'],
    ["(I Can't Get No) Satisfaction (Mono Version)", "(I Can't Get No) Satisfaction"],
    ['Wild Horses (2009 Mix)', 'Wild Horses'],
    ['She’s A Rainbow (Remastered 2017 / Stereo)', 'She’s A Rainbow'],
    ["Jumpin' Jack Flash (Mono Version)", "Jumpin' Jack Flash"],
    ['Tumbling Dice (2005 Digital Remaster)', 'Tumbling Dice'],
    ['If I Ruled the World (Imagine That) (feat. Lauryn Hill)', 'If I Ruled the World (Imagine That)'],
    ['Spicy (ft. Fivio Foreign & A$AP Ferg)', 'Spicy'],
    ['Spicy (feat. Fivio Foreign & A$AP Ferg)', 'Spicy'],
    ['Spicy (featuring Fivio Foreign & A$AP Ferg)', 'Spicy'],
    ['Spicy (feat. Fivio Foreign) the song', 'Spicy the song'],
    ['Fisherman\'s Blues - 2006 Remaster', 'Fisherman\'s Blues'],
    ['A test master', 'A test master'],
    ['The 2020 deluxe', 'The 2020 deluxe'],
    ['Louie Louie - Remastered Studio', 'Louie Louie']
  ]

  for (let i = 0; i < cases.length; i++) {
    const r = cleanUpSongTitle(cases[i][0])
    assert.equal(r, cases[i][1])
  }
  console.log('Ok')
}

testCleanUpSongTitle()
