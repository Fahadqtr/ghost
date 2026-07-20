/* ============================================================
   مولّد QR ذاتي (بدون إنترنت أو خدمات خارجية)
   منقول عن qrcode-generator (Kazuhiko Arase، رخصة MIT).
   يوفّر: QR.make(text) => { size, isDark(row,col) }
          QR.draw(canvas, text, {scale, margin}) لرسمه على canvas
   ============================================================ */
(function(global){
  'use strict';

  // ---- حساب حقل جالوا GF(256) ----
  var EXP = new Array(256), LOG = new Array(256);
  (function(){
    for(var i=0;i<8;i++) EXP[i]=1<<i;
    for(i=8;i<256;i++) EXP[i]=EXP[i-4]^EXP[i-5]^EXP[i-6]^EXP[i-8];
    for(i=0;i<255;i++) LOG[EXP[i]]=i;
  })();
  function gexp(n){ while(n<0)n+=255; while(n>=256)n-=255; return EXP[n]; }
  function glog(n){ return LOG[n]; }

  function Poly(num, shift){
    var offset=0; while(offset<num.length && num[offset]===0) offset++;
    this.num=new Array(num.length-offset+shift);
    for(var i=0;i<num.length-offset;i++) this.num[i]=num[i+offset];
  }
  Poly.prototype={
    get:function(i){return this.num[i];},
    len:function(){return this.num.length;},
    multiply:function(e){
      var num=new Array(this.len()+e.len()-1);
      for(var i=0;i<num.length;i++)num[i]=0;
      for(i=0;i<this.len();i++)for(var j=0;j<e.len();j++)
        num[i+j]^=gexp(glog(this.get(i))+glog(e.get(j)));
      return new Poly(num,0);
    },
    mod:function(e){
      if(this.len()-e.len()<0) return this;
      var ratio=glog(this.get(0))-glog(e.get(0));
      var num=this.num.slice();
      for(var i=0;i<e.len();i++) num[i]^=gexp(glog(e.get(i))+ratio);
      return new Poly(num,0).mod(e);
    }
  };

  // ---- جداول ثابتة (مواضع أنماط المحاذاة + كتل RS) للإصدارات 1..10 ----
  var PATTERN=[[],[6,18],[6,22],[6,26],[6,30],[6,34],[6,22,38],[6,24,42],[6,26,46],[6,28,50]];
  // كل مدخل: [عدد كتل، إجمالي البايت للكتلة، بايت البيانات للكتلة] لمستوى التصحيح M
  // مرتّبة للإصدارات 1..10 (نستخدم M فقط)
  var RS_M=[
    [1,26,16],[1,44,28],[1,70,44],[2,50,32],[2,67,43],
    [4,43,27],[4,49,31],[2,60,38,2,61,39],[3,58,36,2,59,37],[4,69,43,1,70,44]
  ];

  function rsBlocks(ver){
    var d=RS_M[ver-1], list=[];
    for(var i=0;i<d.length;i+=3){
      var count=d[i], total=d[i+1], data=d[i+2];
      for(var j=0;j<count;j++) list.push({total:total,data:data});
    }
    return list;
  }

  function BitBuffer(){ this.buf=[]; this.len=0; }
  BitBuffer.prototype={
    put:function(num,length){ for(var i=0;i<length;i++) this.putBit(((num>>>(length-i-1))&1)===1); },
    putBit:function(bit){
      var idx=Math.floor(this.len/8);
      if(this.buf.length<=idx) this.buf.push(0);
      if(bit) this.buf[idx]|=(0x80>>>(this.len%8));
      this.len++;
    }
  };

  function createData(ver, dataBytes){
    var rsList=rsBlocks(ver), buffer=new BitBuffer();
    buffer.put(4,4); // وضع البايت (8bit)
    buffer.put(dataBytes.length, ver<10?8:16);
    for(var i=0;i<dataBytes.length;i++) buffer.put(dataBytes[i],8);
    var totalData=0; for(i=0;i<rsList.length;i++) totalData+=rsList[i].data;
    if(buffer.len+4<=totalData*8) buffer.put(0,4);
    while(buffer.len%8!==0) buffer.putBit(false);
    while(true){
      if(buffer.len>=totalData*8) break; buffer.put(0xEC,8);
      if(buffer.len>=totalData*8) break; buffer.put(0x11,8);
    }
    return createBytes(buffer, rsList);
  }

  function createBytes(buffer, rsList){
    var offset=0, maxDc=0, maxEc=0, dcdata=[], ecdata=[];
    for(var r=0;r<rsList.length;r++){
      var dc=rsList[r].data, ec=rsList[r].total-dc;
      maxDc=Math.max(maxDc,dc); maxEc=Math.max(maxEc,ec);
      dcdata[r]=new Array(dc);
      for(var i=0;i<dc;i++) dcdata[r][i]=0xff & buffer.buf[i+offset];
      offset+=dc;
      var rsPoly=errorPoly(ec);
      var rawPoly=new Poly(dcdata[r],rsPoly.len()-1);
      var modPoly=rawPoly.mod(rsPoly);
      ecdata[r]=new Array(rsPoly.len()-1);
      for(i=0;i<ecdata[r].length;i++){
        var idx=i+modPoly.len()-ecdata[r].length;
        ecdata[r][i]=idx>=0?modPoly.get(idx):0;
      }
    }
    var out=[];
    for(i=0;i<maxDc;i++) for(r=0;r<rsList.length;r++) if(i<dcdata[r].length) out.push(dcdata[r][i]);
    for(i=0;i<maxEc;i++) for(r=0;r<rsList.length;r++) if(i<ecdata[r].length) out.push(ecdata[r][i]);
    return out;
  }

  function errorPoly(ec){
    var poly=new Poly([1],0);
    for(var i=0;i<ec;i++) poly=poly.multiply(new Poly([1,gexp(i)],0));
    return poly;
  }

  // ---- بناء المصفوفة ----
  function QRModel(ver, data){
    this.ver=ver; this.size=ver*4+17; this.data=data; this.modules=null;
    this.make();
  }
  QRModel.prototype={
    isDark:function(r,c){ return this.modules[r][c]===true; },
    make:function(){
      var best=-1, bestPattern=0;
      for(var m=0;m<8;m++){
        this.build(true,m);
        var lost=lostPoint(this);
        if(best<0||lost<best){ best=lost; bestPattern=m; }
      }
      this.build(false,bestPattern);
    },
    build:function(test,mask){
      var size=this.size; this.modules=[];
      for(var r=0;r<size;r++){ this.modules.push([]); for(var c=0;c<size;c++) this.modules[r].push(null); }
      this.finder(0,0); this.finder(size-7,0); this.finder(0,size-7);
      this.align(); this.timing();
      this.formatInfo(test,mask);
      if(this.ver>=7) this.versionInfo(test);
      this.mapData(this.data,mask);
    },
    finder:function(row,col){
      for(var r=-1;r<=7;r++){ if(row+r<=-1||this.size<=row+r) continue;
        for(var c=-1;c<=7;c++){ if(col+c<=-1||this.size<=col+c) continue;
          var dark=(0<=r&&r<=6&&(c===0||c===6))||(0<=c&&c<=6&&(r===0||r===6))||(2<=r&&r<=4&&2<=c&&c<=4);
          this.modules[row+r][col+c]=dark;
        }}
    },
    timing:function(){
      for(var i=8;i<this.size-8;i++){
        if(this.modules[i][6]===null) this.modules[i][6]=(i%2===0);
        if(this.modules[6][i]===null) this.modules[6][i]=(i%2===0);
      }
    },
    align:function(){
      var pos=PATTERN[this.ver-1];
      for(var i=0;i<pos.length;i++) for(var j=0;j<pos.length;j++){
        var row=pos[i], col=pos[j];
        if(this.modules[row][col]!==null) continue;
        for(var r=-2;r<=2;r++) for(var c=-2;c<=2;c++)
          this.modules[row+r][col+c]=(r===-2||r===2||c===-2||c===2||(r===0&&c===0));
      }
    },
    formatInfo:function(test,mask){
      var data=(1<<3)|mask; // مستوى M = 0b00 << 3، هنا نستخدم بت المستوى=0 (M)
      var bits=(0<<3)|mask; // level M code=0
      var d=bchFormat(bits);
      for(var i=0;i<15;i++){
        var m=(!test)&&((d>>i)&1)===1;
        if(i<6) this.modules[i][8]=m; else if(i<8) this.modules[i+1][8]=m; else this.modules[this.size-15+i][8]=m;
      }
      for(i=0;i<15;i++){
        var m2=(!test)&&((d>>i)&1)===1;
        if(i<8) this.modules[8][this.size-i-1]=m2; else if(i<9) this.modules[8][15-i-1+1]=m2; else this.modules[8][15-i-1]=m2;
      }
      this.modules[this.size-8][8]=(!test);
    },
    versionInfo:function(test){
      var bits=bchVersion(this.ver);
      for(var i=0;i<18;i++){
        var m=(!test)&&((bits>>i)&1)===1;
        this.modules[Math.floor(i/3)][i%3+this.size-8-3]=m;
        this.modules[i%3+this.size-8-3][Math.floor(i/3)]=m;
      }
    },
    mapData:function(data,mask){
      var inc=-1, row=this.size-1, bitIndex=7, byteIndex=0, size=this.size;
      for(var col=size-1;col>0;col-=2){
        if(col===6) col--;
        while(true){
          for(var c=0;c<2;c++){
            if(this.modules[row][col-c]===null){
              var dark=false;
              if(byteIndex<data.length) dark=((data[byteIndex]>>>bitIndex)&1)===1;
              if(maskFn(mask,row,col-c)) dark=!dark;
              this.modules[row][col-c]=dark;
              bitIndex--; if(bitIndex===-1){ byteIndex++; bitIndex=7; }
            }
          }
          row+=inc;
          if(row<0||size<=row){ row-=inc; inc=-inc; break; }
        }
      }
    }
  };

  function maskFn(mask,i,j){
    switch(mask){
      case 0:return (i+j)%2===0; case 1:return i%2===0; case 2:return j%3===0;
      case 3:return (i+j)%3===0; case 4:return (Math.floor(i/2)+Math.floor(j/3))%2===0;
      case 5:return (i*j)%2+(i*j)%3===0; case 6:return ((i*j)%2+(i*j)%3)%2===0;
      case 7:return ((i*j)%3+(i+j)%2)%2===0;
    }
    return false;
  }

  var G15=0x0537, G18=0x1f25, G15_MASK=0x5412;
  function bchDigit(d){ var n=0; while(d!==0){ n++; d>>>=1; } return n; }
  function bchFormat(d){
    var data=d<<10;
    while(bchDigit(data)-bchDigit(G15)>=0) data^=(G15<<(bchDigit(data)-bchDigit(G15)));
    return ((d<<10)|data)^G15_MASK;
  }
  function bchVersion(d){
    var data=d<<12;
    while(bchDigit(data)-bchDigit(G18)>=0) data^=(G18<<(bchDigit(data)-bchDigit(G18)));
    return (d<<12)|data;
  }

  function lostPoint(qr){
    var size=qr.size, lost=0, r,c;
    for(r=0;r<size;r++) for(c=0;c<size;c++){
      var same=0, dark=qr.isDark(r,c);
      for(var dr=-1;dr<=1;dr++){ if(r+dr<0||size<=r+dr) continue;
        for(var dc=-1;dc<=1;dc++){ if(c+dc<0||size<=c+dc) continue; if(dr===0&&dc===0) continue;
          if(dark===qr.isDark(r+dr,c+dc)) same++; }}
      if(same>5) lost+=(3+same-5);
    }
    for(r=0;r<size-1;r++) for(c=0;c<size-1;c++){
      var cnt=0; if(qr.isDark(r,c))cnt++; if(qr.isDark(r+1,c))cnt++; if(qr.isDark(r,c+1))cnt++; if(qr.isDark(r+1,c+1))cnt++;
      if(cnt===0||cnt===4) lost+=3;
    }
    for(r=0;r<size;r++) for(c=0;c<size-6;c++){
      if(qr.isDark(r,c)&&!qr.isDark(r,c+1)&&qr.isDark(r,c+2)&&qr.isDark(r,c+3)&&qr.isDark(r,c+4)&&!qr.isDark(r,c+5)&&qr.isDark(r,c+6)) lost+=40;
    }
    for(c=0;c<size;c++) for(r=0;r<size-6;r++){
      if(qr.isDark(r,c)&&!qr.isDark(r+1,c)&&qr.isDark(r+2,c)&&qr.isDark(r+3,c)&&qr.isDark(r+4,c)&&!qr.isDark(r+5,c)&&qr.isDark(r+6,c)) lost+=40;
    }
    var dark=0; for(r=0;r<size;r++) for(c=0;c<size;c++) if(qr.isDark(r,c)) dark++;
    var ratio=Math.abs(100*dark/size/size-50)/5; lost+=Math.floor(ratio)*10;
    return lost;
  }

  function toBytes(str){
    var out=[]; for(var i=0;i<str.length;i++){
      var c=str.charCodeAt(i);
      if(c<0x80) out.push(c);
      else if(c<0x800){ out.push(0xc0|(c>>6)); out.push(0x80|(c&0x3f)); }
      else { out.push(0xe0|(c>>12)); out.push(0x80|((c>>6)&0x3f)); out.push(0x80|(c&0x3f)); }
    }
    return out;
  }

  function capacityM(ver){ // بايت بيانات متاحة (وضع byte) لمستوى M
    var rs=rsBlocks(ver), data=0; for(var i=0;i<rs.length;i++) data+=rs[i].data;
    return data - (ver<10?2:3); // 4bit mode + 8/16bit length ≈ بايتان/ثلاثة
  }

  function make(text){
    var bytes=toBytes(text), ver=1;
    while(ver<=10 && bytes.length>capacityM(ver)) ver++;
    if(ver>10) ver=10; // احتياط
    var data=createData(ver,bytes);
    return new QRModel(ver,data);
  }

  function draw(canvas, text, opts){
    opts=opts||{}; var scale=opts.scale||6, margin=opts.margin==null?4:opts.margin;
    var qr=make(text), n=qr.size, dim=(n+margin*2)*scale;
    canvas.width=dim; canvas.height=dim;
    var ctx=canvas.getContext('2d');
    ctx.fillStyle=opts.bg||'#ffffff'; ctx.fillRect(0,0,dim,dim);
    ctx.fillStyle=opts.fg||'#000000';
    for(var r=0;r<n;r++) for(var c=0;c<n;c++) if(qr.isDark(r,c))
      ctx.fillRect((c+margin)*scale,(r+margin)*scale,scale,scale);
    return qr;
  }

  global.QR={ make:make, draw:draw };
})(typeof window!=='undefined'?window:this);
