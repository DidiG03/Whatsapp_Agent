(function () {
  function setRowOpen(row, open) {
    const toggle = row.querySelector('.staff-hours__day-toggle input[type="checkbox"]');
    const slots = row.querySelector('.staff-hours__slots');
    const addBtn = row.querySelector('.staff-hours__add-slot');
    const extra = row.querySelector('.staff-hours__slot--extra');
    const inputs = row.querySelectorAll('.staff-hours__time');

    if (toggle) toggle.checked = open;
    if (slots) slots.hidden = !open;
    inputs.forEach(function (input) {
      input.disabled = !open;
    });

    if (!open) {
      if (addBtn) addBtn.hidden = true;
      if (extra) extra.hidden = true;
      return;
    }

    const extraVisible = extra && !extra.hidden;
    if (addBtn) addBtn.hidden = extraVisible;
    if (extra) {
      extra.querySelectorAll('.staff-hours__time').forEach(function (input) {
        input.disabled = !extraVisible;
      });
    }
  }

  function bindRow(row) {
    const toggle = row.querySelector('.staff-hours__day-toggle input[type="checkbox"]');
    const addBtn = row.querySelector('.staff-hours__add-slot');
    const extra = row.querySelector('.staff-hours__slot--extra');
    const removeBtn = extra ? extra.querySelector('.staff-hours__remove-slot') : null;

    if (toggle) {
      toggle.addEventListener('change', function () {
        setRowOpen(row, toggle.checked);
      });
    }

    if (addBtn && extra) {
      addBtn.addEventListener('click', function () {
        extra.hidden = false;
        extra.querySelectorAll('.staff-hours__time').forEach(function (input) {
          input.disabled = false;
        });
        addBtn.hidden = true;
      });
    }

    if (removeBtn && extra) {
      removeBtn.addEventListener('click', function () {
        extra.hidden = true;
        extra.querySelectorAll('.staff-hours__time').forEach(function (input) {
          input.disabled = true;
          input.value = '';
        });
        if (addBtn) addBtn.hidden = false;
      });
    }

    setRowOpen(row, !!(toggle && toggle.checked));
  }

  function copyMondayToWeekdays(block) {
    const monRow = block.querySelector('.staff-hours__row[data-day="mon"]');
    if (!monRow) return;

    ['tue', 'wed', 'thu', 'fri'].forEach(function (day) {
      const row = block.querySelector('.staff-hours__row[data-day="' + day + '"]');
      if (!row) return;

      const monOpen = monRow.querySelector('.staff-hours__day-toggle input[type="checkbox"]');
      const open = !!(monOpen && monOpen.checked);
      setRowOpen(row, open);

      ['', '_2'].forEach(function (suffix) {
        const monStart = monRow.querySelector('[name="hours_mon_start' + suffix + '"]');
        const monEnd = monRow.querySelector('[name="hours_mon_end' + suffix + '"]');
        const targetStart = row.querySelector('[name="hours_' + day + '_start' + suffix + '"]');
        const targetEnd = row.querySelector('[name="hours_' + day + '_end' + suffix + '"]');
        if (targetStart && monStart) targetStart.value = monStart.value;
        if (targetEnd && monEnd) targetEnd.value = monEnd.value;
      });

      const monExtra = monRow.querySelector('.staff-hours__slot--extra');
      const targetExtra = row.querySelector('.staff-hours__slot--extra');
      const monAdd = monRow.querySelector('.staff-hours__add-slot');
      const targetAdd = row.querySelector('.staff-hours__add-slot');
      const extraVisible = monExtra && !monExtra.hidden;
      if (targetExtra) targetExtra.hidden = !extraVisible;
      if (targetAdd) targetAdd.hidden = extraVisible || !open;
      if (targetExtra) {
        targetExtra.querySelectorAll('.staff-hours__time').forEach(function (input) {
          input.disabled = !open || !extraVisible;
        });
      }
    });
  }

  function initStaffWorkingHours() {
    document.querySelectorAll('[data-staff-hours]').forEach(function (block) {
      block.querySelectorAll('.staff-hours__row').forEach(bindRow);

      const copyBtn = block.querySelector('.staff-hours__copy-btn');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          copyMondayToWeekdays(block);
        });
      }
    });
  }

  window.initStaffWorkingHours = initStaffWorkingHours;
})();
