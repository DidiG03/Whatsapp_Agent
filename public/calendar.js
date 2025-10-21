// Simple month calendar renderer
(function(){
  function parseISO(iso){ try { return new Date(iso); } catch { return new Date(); } }
  function startOfMonth(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
  function endOfMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 0); }
  function addMonths(d, n){ return new Date(d.getFullYear(), d.getMonth()+n, 1); }
  function formatMonthYear(d){ return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }); }
  function sameDay(a,b){ return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate(); }

  var state = {
    current: startOfMonth(new Date()),
    appts: []
  };

  function loadAppointments(){
    var el = document.getElementById('appointments-json');
    if(!el) return [];
    try { return JSON.parse(el.textContent||'[]'); } catch { return []; }
  }

  function groupByDay(appts){
    var map = new Map();
    appts.forEach(function(a){
      var d = new Date((a.start_ts||0)*1000);
      var key = d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate();
      if(!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    });
    return map;
  }

  function extractName(apt){
    var raw = (apt.notes||'').split('|')[0] || (apt.contact_phone||'');
    var idx = raw.indexOf(':');
    var name = idx >= 0 ? raw.slice(idx+1) : raw;
    return String(name||'').trim() || 'Booking';
  }

  function render(){
    var root = document.getElementById('calendarRoot');
    if(!root) return;
    root.innerHTML = '';

    var toolbar = document.createElement('div');
    toolbar.className = 'calendar-';
    var left = document.createElement('button'); left.className='btn-ghost'; left.textContent='‹'; left.onclick=function(){ state.current = addMonths(state.current, -1); render(); };
    var right = document.createElement('button'); right.className='btn-ghost'; right.textContent='›'; right.onclick=function(){ state.current = addMonths(state.current, 1); render(); };
    var title = document.createElement('div'); title.className='calendar-title'; title.textContent = formatMonthYear(state.current);
    var legend = document.createElement('div'); legend.className='calendar-legend'; legend.innerHTML = '<span class="swatch swatch-blue"></span> Appointments';
    var leftWrap = document.createElement('div'); leftWrap.style.display='flex'; leftWrap.style.gap='8px'; leftWrap.appendChild(left); leftWrap.appendChild(right);
    var rightWrap = document.createElement('div'); rightWrap.appendChild(legend);
    toolbar.appendChild(title); toolbar.appendChild(leftWrap); toolbar.appendChild(rightWrap);

    var cal = document.createElement('div'); cal.className='calendar';
    var grid = document.createElement('div'); grid.className='calendar-grid';

    var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    days.forEach(function(d){ var h=document.createElement('div'); h.className='calendar-dow'; h.textContent=d; grid.appendChild(h); });

    var first = startOfMonth(state.current);
    var last = endOfMonth(state.current);
    var startIdx = first.getDay();
    var totalDays = last.getDate();

    var apptMap = groupByDay(state.appts);

    // Fill 6 weeks (42 cells)
    for(var i=0;i<42;i++){
      var cell = document.createElement('div'); cell.className='calendar-cell';
      var date = new Date(first); date.setDate(1 - startIdx + i);
      if(date.getMonth() !== state.current.getMonth()) cell.classList.add('other-month');
      var day = document.createElement('div'); day.className='day'; day.textContent=String(date.getDate());
      var list = document.createElement('div'); list.className='calendar-events';
      var key = date.getFullYear()+"-"+(date.getMonth()+1)+"-"+date.getDate();
      var items = apptMap.get(key) || [];
      items.sort(function(a,b){ return a.start_ts - b.start_ts; });
      items.forEach(function(a){
        var ev = document.createElement('div'); ev.className='cal-event';
        ev.textContent = extractName(a);
        list.appendChild(ev);
      });
      cell.appendChild(day); cell.appendChild(list);

      // Click to open modal with all appointments for the day
      if(items.length > 0){
        cell.style.cursor = 'pointer';
        (function(dateCopy, itemsCopy){
          cell.addEventListener('click', function(){ showDayModal(dateCopy, itemsCopy); });
        })(new Date(date), items.slice());
      }
      grid.appendChild(cell);
    }

    cal.appendChild(grid);

    var wrap = document.createElement('div');
    wrap.className = 'card calendar-card';
    wrap.appendChild(toolbar);
    wrap.appendChild(cal);
    root.appendChild(wrap);
  }

  function showDayModal(date, appointments){
    var existing = document.getElementById('dayModal');
    if(existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'dayModal';
    modal.className = 'day-modal';

    var overlay = document.createElement('div');
    overlay.className = 'day-modal-overlay';
    overlay.onclick = function(){ modal.remove(); };

    var content = document.createElement('div');
    content.className = 'day-modal-content';

    var header = document.createElement('div');
    header.className = 'day-modal-header';
    header.innerHTML = '<h3>'+ date.toLocaleDateString(undefined, { weekday:'long', year:'numeric', month:'long', day:'numeric' }) +'</h3>'+
      '<button class="day-modal-close" onclick="document.getElementById(\'dayModal\').remove()">×</button>';

    var body = document.createElement('div');
    body.className = 'day-modal-body';

    if(!appointments || !appointments.length){
      body.innerHTML = '<p class="day-modal-empty">No appointments for this day</p>';
    } else {
      var list = document.createElement('div');
      list.className = 'day-modal-list';
      // sort by start time
      appointments.sort(function(a,b){ return a.start_ts - b.start_ts; });
      appointments.forEach(function(apt){
        var item = document.createElement('div');
        item.className = 'day-modal-item';
        var start = new Date((apt.start_ts||0)*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        var end = new Date((apt.end_ts||0)*1000).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
        var name = extractName(apt);
        var phone = apt.contact_phone || '';
        var staff = apt.staff_name || '';
        var notes = apt.notes || '';
        item.innerHTML =
          '<div class="day-modal-time">'+ start +' - '+ end +'</div>'+
          '<div class="day-modal-name">'+ name +'</div>'+
          (phone ? '<div class="day-modal-phone">'+ phone +'</div>' : '')+
          (staff ? '<div class="day-modal-staff">Staff: '+ staff +'</div>' : '')+
          (notes ? '<div class="day-modal-notes">'+ notes.replace(/\|/g, '<br>') +'</div>' : '');
        list.appendChild(item);
      });
      body.appendChild(list);
    }

    content.appendChild(header);
    content.appendChild(body);
    modal.appendChild(overlay);
    modal.appendChild(content);
    document.body.appendChild(modal);
  }

  function init(){
    var mount = document.getElementById('calendarRoot');
    if(!mount) return;
    state.appts = loadAppointments();
    render();
  }

  document.addEventListener('DOMContentLoaded', init);
})();
