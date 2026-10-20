'use strict';
// pet-kit public entry. Games import ONLY from here (the build checks it).
const Room=require('./room.js'),Wire=require('./wire.js');
module.exports={Assets:require('./asset-codec.js'),VERSION:Room.VERSION,Room,Wire,Motion:require('./motion.js')};
